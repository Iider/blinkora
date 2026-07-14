use super::common::workspace_id;
use crate::app::AppState;
use crate::auth::CurrentUser;
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use futures::FutureExt;
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::SimpleFileOptions;

pub fn router() -> Router<AppState> {
    Router::new().route("/import", post(import_backup))
}

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("task.exportMarkdown", export_markdown);
}

struct MarkdownExportFile {
    path: String,
    content: String,
}

async fn import_backup(
    user: CurrentUser,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mut mode = "workspace".to_string();
    let mut archive_bytes = Vec::new();

    while let Some(field) = multipart.next_field().await.map_err(bad_request)? {
        let Some(name) = field.name().map(ToString::to_string) else {
            continue;
        };
        if name == "mode" {
            mode = field
                .text()
                .await
                .unwrap_or_else(|_| "workspace".to_string());
        } else if name == "file" {
            archive_bytes = field.bytes().await.map_err(bad_request)?.to_vec();
        }
    }

    if archive_bytes.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "backup file is required" })),
        ));
    }
    if mode != "workspace" && mode != "full" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "unsupported import mode" })),
        ));
    }

    let manifest = read_manifest_from_zip(&archive_bytes).map_err(|err| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": err.to_string() })),
        )
    })?;
    if manifest.get("schema").and_then(Value::as_str) != Some("blinkora.backup.v1") {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "unsupported backup schema" })),
        ));
    }

    let workspaces = manifest
        .get("workspaces")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid backup manifest" })),
            )
        })?;
    let selected_workspaces: Vec<&Value> = if mode == "workspace" {
        workspaces.iter().take(1).collect()
    } else {
        workspaces.iter().collect()
    };

    let _write_guard = state.write_guard().await;
    let mut tx = state.pool().begin().await.map_err(internal_error)?;
    let mut imported_workspace_ids = Vec::new();
    let mut imported_note_count = 0usize;
    let mut imported_attachment_count = 0usize;
    let mut restored_attachment_files = 0usize;
    let mut missing_attachment_files = 0usize;

    for item in selected_workspaces {
        let workspace = item.get("workspace").unwrap_or(item);
        let source_name = workspace
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Imported Workspace");
        let imported_name = format!(
            "Imported - {} - {}",
            source_name,
            chrono::Utc::now().format("%Y%m%d%H%M%S")
        );
        let description = workspace
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        let icon = workspace.get("icon").and_then(Value::as_str).unwrap_or("");
        let color = workspace.get("color").and_then(Value::as_str).unwrap_or("");
        let new_workspace_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO workspaces (name, description, icon, color, "accountId", "isDefault", "updatedAt")
               VALUES ($1,$2,$3,$4,$5,false,blinkora_now()) RETURNING id"#,
        )
        .bind(imported_name)
        .bind(description)
        .bind(icon)
        .bind(color)
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal_error)?;
        imported_workspace_ids.push(new_workspace_id);

        let mut tag_id_map: HashMap<i32, i32> = HashMap::new();
        for tag in item
            .get("tags")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_id = tag.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
            let name = tag.get("name").and_then(Value::as_str).unwrap_or("");
            let icon = tag.get("icon").and_then(Value::as_str).unwrap_or("");
            let sort_order = tag.get("sortOrder").and_then(Value::as_i64).unwrap_or(0) as i32;
            let new_tag_id: i32 = sqlx::query_scalar(
                r#"INSERT INTO tag (name, icon, parent, "accountId", "workspaceId", "sortOrder", "updatedAt")
                   VALUES ($1,$2,0,$3,$4,$5,blinkora_now()) RETURNING id"#,
            )
            .bind(name)
            .bind(icon)
            .bind(user.id)
            .bind(new_workspace_id)
            .bind(sort_order)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal_error)?;
            if old_id > 0 {
                tag_id_map.insert(old_id, new_tag_id);
            }
        }
        for tag in item
            .get("tags")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_id = tag.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
            let old_parent = tag
                .get("parent")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let Some(new_id) = tag_id_map.get(&old_id).copied() else {
                continue;
            };
            let Some(new_parent) = tag_id_map.get(&old_parent).copied() else {
                continue;
            };
            sqlx::query(r#"UPDATE tag SET parent=$1, "updatedAt"=blinkora_now() WHERE id=$2"#)
                .bind(new_parent)
                .bind(new_id)
                .execute(&mut *tx)
                .await
                .map_err(internal_error)?;
        }

        let mut attachment_path_map: HashMap<String, String> = HashMap::new();
        for attachment in item
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_path = attachment.get("path").and_then(Value::as_str).unwrap_or("");
            let Some(file_ref) = attachment.get("fileRef").and_then(Value::as_str) else {
                if is_restorable_attachment(attachment) {
                    missing_attachment_files += 1;
                }
                continue;
            };
            let original_name = attachment
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("attachment");
            match restore_zip_file(
                &state.config.data_dir,
                &archive_bytes,
                file_ref,
                original_name,
            ) {
                Ok(new_path) => {
                    attachment_path_map.insert(old_path.to_string(), new_path);
                    restored_attachment_files += 1;
                }
                Err(_) => {
                    missing_attachment_files += 1;
                }
            }
        }

        let mut note_id_map: HashMap<i32, i32> = HashMap::new();
        for note in item
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_id = note.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
            let content = replace_attachment_paths(
                note.get("content").and_then(Value::as_str).unwrap_or(""),
                &attachment_path_map,
            );
            let note_type = note.get("type").and_then(Value::as_i64).unwrap_or(0) as i32;
            let is_archived = note
                .get("isArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let is_recycle = note
                .get("isRecycle")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let is_top = note.get("isTop").and_then(Value::as_bool).unwrap_or(false);
            let is_reviewed = note
                .get("isReviewed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let metadata = note.get("metadata").cloned();
            let sort_order = note.get("sortOrder").and_then(Value::as_i64).unwrap_or(0) as i32;
            let new_note_id: i32 = sqlx::query_scalar(
                r#"INSERT INTO notes (type, content, "isArchived", "isRecycle", "isTop", "isReviewed", metadata, "accountId", "workspaceId", "sortOrder", "updatedAt")
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,blinkora_now()) RETURNING id"#,
            )
            .bind(note_type)
            .bind(content)
            .bind(is_archived)
            .bind(is_recycle)
            .bind(is_top)
            .bind(is_reviewed)
            .bind(metadata)
            .bind(user.id)
            .bind(new_workspace_id)
            .bind(sort_order)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal_error)?;
            if old_id > 0 {
                note_id_map.insert(old_id, new_note_id);
            }
            imported_note_count += 1;
        }

        for note in item
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_note_id = note.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
            let Some(new_note_id) = note_id_map.get(&old_note_id).copied() else {
                continue;
            };
            for old_tag_id in note
                .get("tagIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let old_tag_id = old_tag_id.as_i64().unwrap_or_default() as i32;
                let Some(new_tag_id) = tag_id_map.get(&old_tag_id).copied() else {
                    continue;
                };
                sqlx::query(r#"INSERT INTO "tagsToNote" ("noteId","tagId") VALUES ($1,$2) ON CONFLICT DO NOTHING"#)
                    .bind(new_note_id)
                    .bind(new_tag_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(internal_error)?;
            }
        }

        for attachment in item
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_note_id = attachment
                .get("noteId")
                .and_then(Value::as_i64)
                .map(|value| value as i32);
            let new_note_id = old_note_id.and_then(|id| note_id_map.get(&id).copied());
            let name = attachment.get("name").and_then(Value::as_str).unwrap_or("");
            let old_path = attachment.get("path").and_then(Value::as_str).unwrap_or("");
            let path = attachment_path_map
                .get(old_path)
                .map(String::as_str)
                .unwrap_or(old_path);
            let size = attachment
                .get("size")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            let kind = attachment.get("type").and_then(Value::as_str).unwrap_or("");
            let sort_order = attachment
                .get("sortOrder")
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32;
            let prefix = attachment
                .get("perfixPath")
                .and_then(Value::as_str)
                .unwrap_or("");
            let depth = attachment
                .get("depth")
                .and_then(Value::as_i64)
                .map(|value| value as i32);
            let metadata = attachment.get("metadata").cloned();
            sqlx::query(
                r#"INSERT INTO attachments (name, path, size, type, "noteId", "accountId", "workspaceId", "sortOrder", "perfixPath", depth, metadata, "updatedAt")
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,blinkora_now())"#,
            )
            .bind(name)
            .bind(path)
            .bind(size)
            .bind(kind)
            .bind(new_note_id)
            .bind(user.id)
            .bind(new_workspace_id)
            .bind(sort_order)
            .bind(prefix)
            .bind(depth)
            .bind(metadata)
            .execute(&mut *tx)
            .await
            .map_err(internal_error)?;
            imported_attachment_count += 1;
        }

        for reference in item
            .get("noteReferences")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_from = reference
                .get("fromNoteId")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let old_to = reference
                .get("toNoteId")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let Some(new_from) = note_id_map.get(&old_from).copied() else {
                continue;
            };
            let Some(new_to) = note_id_map.get(&old_to).copied() else {
                continue;
            };
            sqlx::query(r#"INSERT INTO "noteReference" ("fromNoteId","toNoteId") VALUES ($1,$2) ON CONFLICT DO NOTHING"#)
                .bind(new_from)
                .bind(new_to)
                .execute(&mut *tx)
                .await
                .map_err(internal_error)?;
        }

        let mut comment_id_map: HashMap<i32, i32> = HashMap::new();
        for comment in item
            .get("comments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_id = comment
                .get("id")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let old_note_id = comment
                .get("noteId")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let Some(new_note_id) = note_id_map.get(&old_note_id).copied() else {
                continue;
            };
            let content = comment.get("content").and_then(Value::as_str).unwrap_or("");
            let kind = comment
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("annotation");
            let status = comment
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("open");
            let metadata = comment.get("metadata").cloned();
            let new_comment_id: i32 = sqlx::query_scalar(
                r#"INSERT INTO comments (content, kind, status, metadata, "accountId", "noteId", "workspaceId", "parentId", "updatedAt")
                   VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,blinkora_now()) RETURNING id"#,
            )
            .bind(content)
            .bind(kind)
            .bind(status)
            .bind(metadata)
            .bind(user.id)
            .bind(new_note_id)
            .bind(new_workspace_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal_error)?;
            if old_id > 0 {
                comment_id_map.insert(old_id, new_comment_id);
            }
        }
        for comment in item
            .get("comments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_id = comment
                .get("id")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let old_parent = comment
                .get("parentId")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let Some(new_id) = comment_id_map.get(&old_id).copied() else {
                continue;
            };
            let Some(new_parent) = comment_id_map.get(&old_parent).copied() else {
                continue;
            };
            sqlx::query(
                r#"UPDATE comments SET "parentId"=$1, "updatedAt"=blinkora_now() WHERE id=$2"#,
            )
            .bind(new_parent)
            .bind(new_id)
            .execute(&mut *tx)
            .await
            .map_err(internal_error)?;
        }

        for history in item
            .get("noteHistory")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_note_id = history
                .get("noteId")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let Some(new_note_id) = note_id_map.get(&old_note_id).copied() else {
                continue;
            };
            let content = history.get("content").and_then(Value::as_str).unwrap_or("");
            let metadata = history.get("metadata").cloned();
            let version = history.get("version").and_then(Value::as_i64).unwrap_or(1) as i32;
            sqlx::query(
                r#"INSERT INTO "noteHistory" ("noteId", content, metadata, version, "accountId", "workspaceId")
                   VALUES ($1,$2,$3,$4,$5,$6)"#,
            )
            .bind(new_note_id)
            .bind(content)
            .bind(metadata)
            .bind(version)
            .bind(user.id)
            .bind(new_workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(internal_error)?;
        }

        for log in item
            .get("operationLogs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let old_note_id = log
                .get("noteId")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32;
            let new_note_id = note_id_map.get(&old_note_id).copied();
            let mut details = log.get("details").cloned().unwrap_or_else(|| json!({}));
            if !details.is_object() {
                details = json!({ "value": details });
            }
            if let Some(object) = details.as_object_mut() {
                object.insert(
                    "originalActor".to_string(),
                    json!({
                        "accountId": log.get("actorAccountId").cloned().unwrap_or(Value::Null),
                        "agentTokenId": log.get("actorAgentTokenId").cloned().unwrap_or(Value::Null)
                    }),
                );
                if old_note_id > 0 && new_note_id.is_none() {
                    object.insert("originalNoteId".to_string(), json!(old_note_id));
                }
            }
            let actor_type = log
                .get("actorType")
                .and_then(Value::as_str)
                .unwrap_or("user");
            let actor_label = log.get("actorLabel").and_then(Value::as_str).unwrap_or("");
            let action = log.get("action").and_then(Value::as_str).unwrap_or("");
            let note_type = log
                .get("noteType")
                .and_then(Value::as_i64)
                .map(|value| value as i32);
            let note_title = log.get("noteTitle").and_then(Value::as_str).unwrap_or("");
            let changed_fields = log
                .get("changedFields")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let summary = log.get("summary").and_then(Value::as_str).unwrap_or("");
            let created_at = log
                .get("createdAt")
                .and_then(Value::as_str)
                .map(str::to_string);
            sqlx::query(
                r#"INSERT INTO "operationLog"
                   ("accountId", "workspaceId", "actorType", "actorAccountId", "actorAgentTokenId",
                    "actorLabel", action, "noteId", "noteType", "noteTitle", "changedFields", summary, details, "createdAt")
                   VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, blinkora_now()))"#,
            )
            .bind(user.id)
            .bind(new_workspace_id)
            .bind(actor_type)
            .bind(Some(user.id))
            .bind(actor_label)
            .bind(action)
            .bind(new_note_id)
            .bind(note_type)
            .bind(note_title)
            .bind(changed_fields)
            .bind(summary)
            .bind(details)
            .bind(created_at)
            .execute(&mut *tx)
            .await
            .map_err(internal_error)?;
        }

        for config in item
            .get("configs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let key = config.get("key").and_then(Value::as_str).unwrap_or("");
            let value = config.get("config").cloned();
            if key.is_empty() {
                continue;
            }
            sqlx::query(
                r#"INSERT INTO config (key, config, "userId", "workspaceId") VALUES ($1,$2,$3,$4)"#,
            )
            .bind(key)
            .bind(value)
            .bind(user.id)
            .bind(new_workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(internal_error)?;
        }
    }

    tx.commit().await.map_err(internal_error)?;

    Ok(Json(json!({
        "success": true,
        "mode": mode,
        "workspaceIds": imported_workspace_ids,
        "workspaceCount": imported_workspace_ids.len(),
        "noteCount": imported_note_count,
        "attachmentCount": imported_attachment_count,
        "restoredAttachmentFiles": restored_attachment_files,
        "missingAttachmentFiles": missing_attachment_files
    })))
}

fn export_markdown(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let format = input.get("format").and_then(Value::as_str).unwrap_or("markdown");
        let scope = input.get("scope").and_then(Value::as_str).unwrap_or("workspace");
        if format != "markdown" && format != "json" {
            bail!("unsupported export format");
        }
        if scope != "workspace" && scope != "full" {
            bail!("unsupported export scope");
        }
        let workspaces = if scope == "full" {
            sqlx::query(r#"SELECT id, name, description, icon, color, "isDefault", "createdAt", "updatedAt" FROM workspaces WHERE "accountId"=$1 ORDER BY "isDefault" DESC, id ASC"#)
                .bind(user.id)
                .fetch_all(ctx.state.pool())
                .await?
        } else {
            sqlx::query(r#"SELECT id, name, description, icon, color, "isDefault", "createdAt", "updatedAt" FROM workspaces WHERE "accountId"=$1 AND id=$2"#)
                .bind(user.id)
                .bind(ws)
                .fetch_all(ctx.state.pool())
                .await?
        };
        let mut manifest_workspaces = Vec::new();
        let mut markdown_files: Vec<MarkdownExportFile> = Vec::new();
        let mut note_count = 0usize;
        let mut attachment_count = 0usize;
        for workspace in workspaces {
            let workspace_id: i32 = workspace.get("id");
            let notes = sqlx::query(
                r#"SELECT id, type, content, "isArchived", "isRecycle", "isTop", "isReviewed", metadata, "sortOrder", "createdAt", "updatedAt"
                   FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2 ORDER BY "createdAt" ASC, id ASC"#,
            )
            .bind(user.id)
            .bind(workspace_id)
            .fetch_all(ctx.state.pool())
            .await?;
            let attachments = sqlx::query(
                r#"SELECT id, name, path, CAST(size AS TEXT) AS size, type, "noteId", "sortOrder", "perfixPath", depth, metadata, "createdAt", "updatedAt"
                   FROM attachments WHERE "accountId"=$1 AND "workspaceId"=$2 ORDER BY id ASC"#,
            )
            .bind(user.id)
            .bind(workspace_id)
            .fetch_all(ctx.state.pool())
            .await?;
            let tags = sqlx::query(
                r#"SELECT id, name, icon, parent, "sortOrder", "createdAt", "updatedAt"
                   FROM tag WHERE "accountId"=$1 AND "workspaceId"=$2 ORDER BY parent ASC, "sortOrder" ASC, id ASC"#,
            )
            .bind(user.id)
            .bind(workspace_id)
            .fetch_all(ctx.state.pool())
            .await?;
            let configs = sqlx::query(
                r#"SELECT id, key, config FROM config WHERE "userId"=$1 AND "workspaceId"=$2 ORDER BY id ASC"#,
            )
            .bind(user.id)
            .bind(workspace_id)
            .fetch_all(ctx.state.pool())
            .await?;
            let note_ids: Vec<i32> = notes.iter().map(|row| row.get::<i32, _>("id")).collect();
            let tag_links = if note_ids.is_empty() {
                Vec::new()
            } else {
                sqlx::query(r#"SELECT "noteId", "tagId" FROM "tagsToNote" WHERE "noteId" IN (SELECT value FROM json_each($1))"#)
                    .bind(crate::db::json_array(&note_ids))
                    .fetch_all(ctx.state.pool())
                    .await?
            };
            let comments = if note_ids.is_empty() {
                Vec::new()
            } else {
                sqlx::query(
                    r#"SELECT id, "noteId", content, kind, status, metadata, "parentId", "createdAt", "updatedAt"
                       FROM comments WHERE "noteId" IN (SELECT value FROM json_each($1)) AND "workspaceId"=$2 ORDER BY "createdAt" ASC, id ASC"#,
                )
                .bind(crate::db::json_array(&note_ids))
                .bind(workspace_id)
                .fetch_all(ctx.state.pool())
                .await?
            };
            let note_references = if note_ids.is_empty() {
                Vec::new()
            } else {
                sqlx::query(
                    r#"SELECT id, "fromNoteId", "toNoteId", "createdAt"
                       FROM "noteReference" WHERE "fromNoteId" IN (SELECT value FROM json_each($1)) AND "toNoteId" IN (SELECT value FROM json_each($1))
                       ORDER BY "createdAt" ASC, id ASC"#,
                )
                .bind(crate::db::json_array(&note_ids))
                .fetch_all(ctx.state.pool())
                .await?
            };
            let note_history = if note_ids.is_empty() {
                Vec::new()
            } else {
                sqlx::query(
                    r#"SELECT id, "noteId", content, metadata, version, "createdAt"
                       FROM "noteHistory" WHERE "noteId" IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3
                       ORDER BY "noteId" ASC, version ASC, id ASC"#,
                )
                .bind(crate::db::json_array(&note_ids))
                .bind(user.id)
                .bind(workspace_id)
                .fetch_all(ctx.state.pool())
                .await?
            };
            let operation_logs = if format == "json" {
                sqlx::query(
                    r#"SELECT id, "actorType", "actorAccountId", "actorAgentTokenId", "actorLabel",
                              action, "noteId", "noteType", "noteTitle", "changedFields", summary, details, "createdAt"
                       FROM "operationLog" WHERE "accountId"=$1 AND "workspaceId"=$2
                       ORDER BY id ASC"#,
                )
                .bind(user.id)
                .bind(workspace_id)
                .fetch_all(ctx.state.pool())
                .await?
            } else {
                Vec::new()
            };
            let mut tag_ids_by_note: HashMap<i32, Vec<i32>> = HashMap::new();
            for row in tag_links {
                tag_ids_by_note
                    .entry(row.get::<i32, _>("noteId"))
                    .or_default()
                    .push(row.get::<i32, _>("tagId"));
            }
            note_count += notes.len();
            attachment_count += attachments.len();
            let mut manifest_notes = Vec::new();
            for row in notes {
                let note_id = row.get::<i32, _>("id");
                let content = row.get::<String, _>("content");
                let metadata = row.get::<Option<Value>, _>("metadata");
                if format == "markdown" {
                    markdown_files.push(MarkdownExportFile {
                        path: format!("markdown/workspace-{workspace_id}/note-{note_id}.md"),
                        content: markdown_note_content(&content, metadata.as_ref())?,
                    });
                }
                manifest_notes.push(json!({
                    "id": note_id,
                    "type": row.get::<i32, _>("type"),
                    "content": content,
                    "isArchived": row.get::<bool, _>("isArchived"),
                    "isRecycle": row.get::<bool, _>("isRecycle"),
                    "isTop": row.get::<bool, _>("isTop"),
                    "isReviewed": row.get::<bool, _>("isReviewed"),
                    "metadata": metadata,
                    "sortOrder": row.get::<i32, _>("sortOrder"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
                    "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt"),
                    "tagIds": tag_ids_by_note.get(&note_id).cloned().unwrap_or_default()
                }));
            }
            manifest_workspaces.push(json!({
                "workspace": {
                    "id": workspace_id,
                    "name": workspace.get::<String, _>("name"),
                    "description": workspace.get::<String, _>("description"),
                    "icon": workspace.get::<String, _>("icon"),
                    "color": workspace.get::<String, _>("color"),
                    "isDefault": workspace.get::<bool, _>("isDefault"),
                    "createdAt": workspace.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
                    "updatedAt": workspace.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
                },
                "notes": manifest_notes,
                "attachments": attachments.into_iter().map(|row| json!({
                    "id": row.get::<i32, _>("id"),
                    "name": row.get::<String, _>("name"),
                    "path": row.get::<String, _>("path"),
                    "size": row.get::<String, _>("size"),
                    "type": row.get::<String, _>("type"),
                    "noteId": row.get::<Option<i32>, _>("noteId"),
                    "sortOrder": row.get::<i32, _>("sortOrder"),
                    "perfixPath": row.get::<Option<String>, _>("perfixPath"),
                    "depth": row.get::<Option<i32>, _>("depth"),
                    "metadata": row.get::<Option<Value>, _>("metadata"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
                    "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
                })).collect::<Vec<_>>(),
                "tags": tags.into_iter().map(|row| json!({
                    "id": row.get::<i32, _>("id"),
                    "name": row.get::<String, _>("name"),
                    "icon": row.get::<String, _>("icon"),
                    "parent": row.get::<i32, _>("parent"),
                    "sortOrder": row.get::<i32, _>("sortOrder"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
                    "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
                })).collect::<Vec<_>>(),
                "configs": configs.into_iter().map(|row| json!({
                    "id": row.get::<i32, _>("id"),
                    "key": row.get::<String, _>("key"),
                    "config": row.get::<Option<Value>, _>("config")
                })).collect::<Vec<_>>(),
                "comments": comments.into_iter().map(|row| json!({
                    "id": row.get::<i32, _>("id"),
                    "noteId": row.get::<i32, _>("noteId"),
                    "content": row.get::<String, _>("content"),
                    "kind": row.get::<String, _>("kind"),
                    "status": row.get::<String, _>("status"),
                    "metadata": row.get::<Option<Value>, _>("metadata"),
                    "parentId": row.get::<Option<i32>, _>("parentId"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
                    "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
                })).collect::<Vec<_>>(),
                "noteReferences": note_references.into_iter().map(|row| json!({
                    "id": row.get::<i32, _>("id"),
                    "fromNoteId": row.get::<i32, _>("fromNoteId"),
                    "toNoteId": row.get::<i32, _>("toNoteId"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt")
                })).collect::<Vec<_>>(),
                "noteHistory": note_history.into_iter().map(|row| json!({
                    "id": row.get::<i32, _>("id"),
                    "noteId": row.get::<i32, _>("noteId"),
                    "content": row.get::<String, _>("content"),
                    "metadata": row.get::<Option<Value>, _>("metadata"),
                    "version": row.get::<i32, _>("version"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt")
                })).collect::<Vec<_>>(),
                "operationLogs": operation_logs.into_iter().map(|row| json!({
                    "id": row.get::<i32, _>("id"),
                    "actorType": row.get::<String, _>("actorType"),
                    "actorAccountId": row.get::<Option<i32>, _>("actorAccountId"),
                    "actorAgentTokenId": row.get::<Option<i32>, _>("actorAgentTokenId"),
                    "actorLabel": row.get::<String, _>("actorLabel"),
                    "action": row.get::<String, _>("action"),
                    "noteId": row.get::<Option<i32>, _>("noteId"),
                    "noteType": row.get::<Option<i32>, _>("noteType"),
                    "noteTitle": row.get::<String, _>("noteTitle"),
                    "changedFields": row.get::<Option<Value>, _>("changedFields"),
                    "summary": row.get::<String, _>("summary"),
                    "details": row.get::<Option<Value>, _>("details"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt")
                })).collect::<Vec<_>>()
            }));
        }
        let mut manifest = json!({
            "schema": "blinkora.backup.v1",
            "app": "blinkora",
            "version": 1,
            "exportedAt": chrono::Utc::now(),
            "scope": scope,
            "format": format,
            "workspaceCount": manifest_workspaces.len(),
            "noteCount": note_count,
            "attachmentCount": attachment_count,
            "missingFileCount": 0,
            "workspaces": manifest_workspaces
        });
        let temp_dir = PathBuf::from(&ctx.state.config.data_dir).join("files").join("temp");
        fs::create_dir_all(&temp_dir)?;
        let file_name = format!("blinkora-export-{}.zip", chrono::Utc::now().timestamp_millis());
        let archive_path = temp_dir.join(&file_name);
        let file = File::create(&archive_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let (attachment_file_count, missing_file_count) = add_attachment_files_to_zip(&mut zip, &mut manifest, &ctx.state.config.data_dir, options)?;
        if format == "markdown" {
            add_markdown_files_to_zip(&mut zip, &markdown_files, options)?;
        }
        manifest["attachmentFileCount"] = json!(attachment_file_count);
        manifest["missingFileCount"] = json!(missing_file_count);
        zip.start_file("manifest.json", options)?;
        zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
        zip.finish()?;
        Ok(json!({
            "success": true,
            "downloadUrl": format!("/api/file/temp/{file_name}"),
            "fileCount": note_count,
            "workspaceCount": manifest["workspaceCount"],
            "attachmentCount": attachment_count,
            "missingFileCount": missing_file_count,
            "scope": scope
        }))
    }
    .boxed()
}

fn add_markdown_files_to_zip(
    zip: &mut zip::ZipWriter<File>,
    markdown_files: &[MarkdownExportFile],
    options: SimpleFileOptions,
) -> anyhow::Result<()> {
    for markdown_file in markdown_files {
        zip.start_file(&markdown_file.path, options)?;
        zip.write_all(markdown_file.content.as_bytes())?;
    }
    Ok(())
}

fn markdown_note_content(content: &str, metadata: Option<&Value>) -> anyhow::Result<String> {
    let frontmatter = note_properties_frontmatter(metadata)?;
    Ok(match frontmatter {
        Some(frontmatter) => format!("{frontmatter}{content}"),
        None => content.to_string(),
    })
}

fn note_properties_frontmatter(metadata: Option<&Value>) -> anyhow::Result<Option<String>> {
    let Some(properties) = metadata.and_then(|value| value.get("properties")) else {
        return Ok(None);
    };
    let Some(properties) = sanitize_note_properties(properties) else {
        return Ok(None);
    };
    let yaml = serde_yaml::to_string(&properties)?;
    if yaml.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(format!("---\n{}---\n\n", yaml.trim_end())))
}

fn sanitize_note_properties(properties: &Value) -> Option<Map<String, Value>> {
    let object = properties.as_object()?;
    let mut sanitized = Map::new();
    let mut keys = object.keys().collect::<Vec<_>>();
    keys.sort();

    for key in keys {
        let value = object.get(key)?;
        if is_supported_note_property_value(value) {
            sanitized.insert(key.to_string(), value.clone());
        }
    }

    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

fn is_supported_note_property_value(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        Value::Number(number) => number.as_f64().map(f64::is_finite).unwrap_or(true),
        Value::Array(items) => items.iter().all(Value::is_string),
        Value::Object(_) => false,
    }
}

fn add_attachment_files_to_zip(
    zip: &mut zip::ZipWriter<File>,
    manifest: &mut Value,
    data_dir: &str,
    options: SimpleFileOptions,
) -> anyhow::Result<(usize, usize)> {
    let mut attachment_file_count = 0usize;
    let mut missing_file_count = 0usize;
    let Some(workspaces) = manifest.get_mut("workspaces").and_then(Value::as_array_mut) else {
        return Ok((0, 0));
    };
    for workspace in workspaces {
        let workspace_id = workspace
            .get("workspace")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let Some(attachments) = workspace
            .get_mut("attachments")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for attachment in attachments {
            if !is_restorable_attachment(attachment) {
                continue;
            }
            let path = attachment.get("path").and_then(Value::as_str).unwrap_or("");
            let Some(relative_path) = api_file_relative_path(path) else {
                missing_file_count += 1;
                attachment["fileMissing"] = json!(true);
                continue;
            };
            let file_path = Path::new(data_dir).join("files").join(relative_path);
            let Ok(content) = fs::read(&file_path) else {
                missing_file_count += 1;
                attachment["fileMissing"] = json!(true);
                continue;
            };
            let attachment_id = attachment
                .get("id")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let name = sanitize_file_name(
                attachment
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| {
                        file_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("attachment")
                    }),
            );
            let file_ref =
                format!("files/workspace-{workspace_id}/attachment-{attachment_id}/{name}");
            zip.start_file(&file_ref, options)?;
            zip.write_all(&content)?;
            attachment["fileRef"] = json!(file_ref);
            attachment_file_count += 1;
        }
    }
    Ok((attachment_file_count, missing_file_count))
}

fn restore_zip_file(
    data_dir: &str,
    archive_bytes: &[u8],
    file_ref: &str,
    original_name: &str,
) -> anyhow::Result<String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(archive_bytes))?;
    let mut file = archive.by_name(file_ref)?;
    let mut content = Vec::new();
    file.read_to_end(&mut content)?;
    let safe_name = sanitize_file_name(original_name);
    let extension = Path::new(&safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let file_name = format!(
        "{}_{}{}",
        chrono::Utc::now().timestamp_millis(),
        Uuid::new_v4().simple(),
        extension
    );
    let root = Path::new(data_dir).join("files");
    fs::create_dir_all(&root)?;
    fs::write(root.join(&file_name), content)?;
    Ok(format!("/api/file/{file_name}"))
}

fn replace_attachment_paths(content: &str, path_map: &HashMap<String, String>) -> String {
    let mut next = content.to_string();
    for (old_path, new_path) in path_map {
        next = next.replace(old_path, new_path);
    }
    next
}

fn is_restorable_attachment(attachment: &Value) -> bool {
    let path = attachment.get("path").and_then(Value::as_str).unwrap_or("");
    let kind = attachment.get("type").and_then(Value::as_str).unwrap_or("");
    let name = attachment.get("name").and_then(Value::as_str).unwrap_or("");
    !path.is_empty()
        && kind != "folder"
        && name != ".folder"
        && (path.starts_with("/api/file/") || path.starts_with("/api/s3file/"))
}

fn api_file_relative_path(path: &str) -> Option<PathBuf> {
    let relative = path
        .strip_prefix("/api/file/")
        .or_else(|| path.strip_prefix("/api/s3file/"))?;
    if relative.contains('\0')
        || relative.contains('\\')
        || relative.starts_with('/')
        || relative.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(PathBuf::from(relative))
}

fn sanitize_file_name(name: impl AsRef<str>) -> String {
    let name = name
        .as_ref()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .rsplit('\\')
        .next()
        .unwrap_or("");
    let sanitized: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_control()
                || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else if ch.is_whitespace() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "attachment".to_string()
    } else {
        trimmed.to_string()
    }
}

fn read_manifest_from_zip(bytes: &[u8]) -> anyhow::Result<Value> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)?;
    for name in ["manifest.json", "backup.json"] {
        if let Ok(mut file) = archive.by_name(name) {
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            return Ok(serde_json::from_str(&content)?);
        }
    }
    bail!("backup manifest not found")
}

fn bad_request(error: impl std::fmt::Display) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": error.to_string() })),
    )
}

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, Json<Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": error.to_string() })),
    )
}
