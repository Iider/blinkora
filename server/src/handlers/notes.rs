use super::common::{note_json, workspace_id};
use super::operation_logs::{
    content_change_detail, content_hash, insert_note_log_if_enabled_tx, note_title,
    OperationLogDraft,
};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use crate::util::unwrap_config_value;
use anyhow::{anyhow, bail};
use futures::FutureExt;
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::{QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::{HashMap, HashSet};

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("notes.list", list);
    registry.insert("notes.listByIds", list_by_ids);
    registry.insert("notes.detail", detail);
    registry.insert("notes.dailyReviewNoteList", daily_review);
    registry.insert("notes.randomNoteList", random_list);
    registry.insert("notes.reviewNote", review);
    registry.insert("notes.upsert", upsert);
    registry.insert("notes.moveToWorkspace", move_to_workspace);
    registry.insert("notes.updateMany", update_many);
    registry.insert("notes.trashMany", trash_many);
    registry.insert("notes.deleteMany", delete_many);
    registry.insert("notes.deleteImpact", delete_impact);
    registry.insert("notes.addReference", add_reference);
    registry.insert("notes.removeReference", remove_reference);
    registry.insert("notes.setReferences", set_references);
    registry.insert("notes.noteReferenceList", reference_list);
    registry.insert("notes.clearRecycleBin", clear_recycle_bin);
    registry.insert("notes.updateAttachmentsOrder", update_attachments_order);
    registry.insert("notes.updateNotesOrder", update_notes_order);
    registry.insert("notes.getNoteHistory", get_history);
    registry.insert("notes.getNoteVersion", get_version);
}

struct NoteListFilters<'a> {
    user_id: i32,
    workspace_id: i32,
    note_type: i64,
    is_recycle: bool,
    is_archived: Option<&'a Value>,
    tag_id: Option<i32>,
    with_file: bool,
    without_tag: bool,
    metadata_filter: Option<Value>,
    search: &'a str,
    with_link: bool,
    has_todo: bool,
    start_date: Option<&'a str>,
    end_date: Option<&'a str>,
}

#[derive(Clone)]
struct NoteSnapshot {
    id: i32,
    content: String,
    note_type: i32,
    metadata: Option<Value>,
    is_archived: bool,
    is_recycle: bool,
    is_top: bool,
    is_reviewed: bool,
}

fn push_note_list_filters(query: &mut QueryBuilder<'_, Sqlite>, filters: &NoteListFilters<'_>) {
    query.push(r#"n."accountId"="#).push_bind(filters.user_id);
    query
        .push(r#" AND n."workspaceId"="#)
        .push_bind(filters.workspace_id);
    query
        .push(r#" AND n."isRecycle"="#)
        .push_bind(filters.is_recycle);

    if !filters.is_recycle {
        match filters.is_archived {
            Some(Value::Null) => {}
            Some(Value::Bool(value)) => {
                query.push(r#" AND n."isArchived"="#).push_bind(*value);
            }
            _ => {
                query.push(r#" AND n."isArchived"="#).push_bind(false);
            }
        }
    }
    if filters.note_type != -1 {
        query
            .push(" AND n.type=")
            .push_bind(filters.note_type as i32);
    }
    if let Some(tag_id) = filters.tag_id {
        query
            .push(r#" AND EXISTS (SELECT 1 FROM "tagsToNote" ttn2 WHERE ttn2."noteId"=n.id AND ttn2."tagId"="#)
            .push_bind(tag_id)
            .push(")");
    }
    if filters.with_file {
        query.push(r#" AND EXISTS (SELECT 1 FROM attachments a2 WHERE a2."noteId"=n.id)"#);
    }
    if filters.without_tag {
        query.push(r#" AND NOT EXISTS (SELECT 1 FROM "tagsToNote" ttn3 WHERE ttn3."noteId"=n.id)"#);
    }
    if let Some(metadata_filter) = filters.metadata_filter.clone() {
        query.push(" AND blinkora_json_contains(COALESCE(n.metadata, '{}'), ");
        query.push_bind(metadata_filter);
        query.push(")");
    }
    if !filters.search.is_empty() {
        let pattern = format!("%{}%", filters.search);
        query.push(" AND (n.content LIKE ");
        query.push_bind(pattern.clone());
        query.push(
            r#" OR EXISTS (SELECT 1 FROM attachments a3 WHERE a3."noteId"=n.id AND a3.path LIKE "#,
        );
        query.push_bind(pattern);
        query.push("))");
    }
    if filters.with_link {
        query.push(" AND (n.content LIKE '%http://%' OR n.content LIKE '%https://%')");
    }
    if filters.has_todo {
        query.push(" AND (n.content LIKE '%- [ ]%' OR n.content LIKE '%- [x]%' OR n.content LIKE '%* [ ]%' OR n.content LIKE '%* [x]%')");
    }
    if let (Some(start_date), Some(end_date)) = (filters.start_date, filters.end_date) {
        query
            .push(r#" AND blinkora_timestamp_micros(n."createdAt") >= blinkora_timestamp_micros("#);
        query.push_bind(start_date.to_string());
        query.push(
            r#") AND blinkora_timestamp_micros(n."createdAt") <= blinkora_timestamp_micros("#,
        );
        query.push_bind(end_date.to_string());
        query.push(")");
    }
}

fn list(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let page = input.get("page").and_then(Value::as_i64).unwrap_or(1).max(1);
        let size = input.get("size").and_then(Value::as_i64).unwrap_or(30).clamp(1, 200);
        let note_type = input.get("type").and_then(Value::as_i64).unwrap_or(-1);
        let is_recycle = input.get("isRecycle").and_then(Value::as_bool).unwrap_or(false);
        let raw_search = input.get("searchText").and_then(Value::as_str).unwrap_or("");
        let metadata_filter = input
            .get("metadata")
            .or_else(|| input.get("metadataContains"))
            .filter(|value| value.is_object())
            .cloned();
        let is_archived = input.get("isArchived");
        let tag_id = input.get("tagId").and_then(Value::as_i64).map(|value| value as i32);
        let with_file = input.get("withFile").and_then(Value::as_bool).unwrap_or(false);
        let without_tag = input.get("withoutTag").and_then(Value::as_bool).unwrap_or(false);
        let with_link = input.get("withLink").and_then(Value::as_bool).unwrap_or(false);
        let has_todo = input.get("hasTodo").and_then(Value::as_bool).unwrap_or(false);
        let start_date = input.get("startDate").and_then(Value::as_str).filter(|value| !value.is_empty());
        let end_date = input.get("endDate").and_then(Value::as_str).filter(|value| !value.is_empty());
        let order_dir = if input.get("orderBy").and_then(Value::as_str) == Some("asc") {
            "ASC"
        } else {
            "DESC"
        };
        let include_page_info = input.get("includePageInfo").and_then(Value::as_bool).unwrap_or(false);
        let search = raw_search;
        let offset = (page - 1) * size;

        let filters = NoteListFilters {
            user_id: user.id,
            workspace_id: ws,
            note_type,
            is_recycle,
            is_archived,
            tag_id,
            with_file,
            without_tag,
            metadata_filter,
            search,
            with_link,
            has_todo,
            start_date,
            end_date,
        };

        let mut query = QueryBuilder::<Sqlite>::new(
            r#"SELECT n.id, n.type, n.content, n."isArchived", n."isRecycle", n."isTop", n."isReviewed", n.metadata,
                      n."accountId", n."workspaceId", n."sortOrder", n."createdAt", n."updatedAt"
               FROM notes n WHERE "#,
        );
        push_note_list_filters(&mut query, &filters);

        let time_order_column = if bool_config(&ctx, user.id, ws, "isOrderByCreateTime").await? {
            r#"n."createdAt""#
        } else {
            r#"n."updatedAt""#
        };
        query.push(r#" ORDER BY n."isTop" DESC, "#);
        query
            .push(r#"n."sortOrder" ASC, "#)
            .push(time_order_column)
            .push(" ")
            .push(order_dir);
        query
            .push(" LIMIT ")
            .push_bind(size)
            .push(" OFFSET ")
            .push_bind(offset);
        let total = if include_page_info {
            let mut count_query = QueryBuilder::<Sqlite>::new(r#"SELECT COUNT(*) FROM notes n WHERE "#);
            push_note_list_filters(&mut count_query, &filters);
            count_query.build_query_scalar::<i64>().fetch_one(ctx.state.pool()).await?
        } else {
            0
        };
        let rows = query.build().fetch_all(ctx.state.pool()).await?;
        let mut items = Vec::new();
        for row in rows {
            items.push(note_json(&ctx, row).await?);
        }
        if include_page_info {
            let mut total = total;
            if total < 0 {
                total = 0;
            }
            Ok(json!({
                "items": items,
                "total": total,
                "page": page,
                "size": size
            }))
        } else {
            Ok(Value::Array(items))
        }
    }
    .boxed()
}

async fn bool_config(
    ctx: &ProcedureContext,
    user_id: i32,
    workspace_id: i32,
    key: &str,
) -> anyhow::Result<bool> {
    let row = sqlx::query(
        r#"SELECT config FROM config
           WHERE key=$1 AND ("userId" IS NULL OR ("userId"=$2 AND "workspaceId"=$3))
           ORDER BY CASE WHEN "userId"=$2 AND "workspaceId"=$3 THEN 0 ELSE 1 END
           LIMIT 1"#,
    )
    .bind(key)
    .bind(user_id)
    .bind(workspace_id)
    .fetch_optional(ctx.state.pool())
    .await?;
    Ok(row
        .and_then(|row| row.try_get::<Option<Value>, _>("config").ok().flatten())
        .map(|value| unwrap_config_value(Some(value)))
        .and_then(|value| value.as_bool())
        .unwrap_or(false))
}

fn list_by_ids(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let ids = ids_from_input(&input);
        let rows = sqlx::query(&note_select_sql("id IN (SELECT value FROM json_each($3))"))
            .bind(user.id)
            .bind(ws)
            .bind(crate::db::json_array(&ids))
            .fetch_all(ctx.state.pool())
            .await?;
        let mut items = Vec::new();
        for row in rows {
            items.push(note_json(&ctx, row).await?);
        }
        Ok(Value::Array(items))
    }
    .boxed()
}

fn detail(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let row = sqlx::query(&note_select_sql("id=$3"))
            .bind(user.id)
            .bind(ws)
            .bind(id)
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(note_json(&ctx, row).await?)
    }
    .boxed()
}

fn daily_review(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let rows = sqlx::query(&note_select_sql(
            r#""isReviewed"=false AND "isArchived"=false AND "isRecycle"=false LIMIT 20"#,
        ))
        .bind(user.id)
        .bind(ws)
        .fetch_all(ctx.state.pool())
        .await?;
        let mut items = Vec::new();
        for row in rows {
            items.push(note_json(&ctx, row).await?);
        }
        Ok(Value::Array(items))
    }
    .boxed()
}

fn random_list(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let rows = sqlx::query(
            r#"SELECT id, type, content, "isArchived", "isRecycle", "isTop", "isReviewed", metadata, "accountId", "workspaceId", "sortOrder", "createdAt", "updatedAt"
               FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2 AND "isArchived"=false AND "isRecycle"=false ORDER BY RANDOM() LIMIT 20"#,
        )
        .bind(user.id)
        .bind(ws)
        .fetch_all(ctx.state.pool())
        .await?;
        let mut items = Vec::new();
        for row in rows {
            items.push(note_json(&ctx, row).await?);
        }
        Ok(Value::Array(items))
    }
    .boxed()
}

fn review(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let mut tx = ctx.state.pool().begin().await?;
        let Some(old) = note_snapshot_tx(&mut tx, id, user.id, ws).await? else {
            bail!("Note not found");
        };
        sqlx::query(r#"UPDATE notes SET "isReviewed"=true, "updatedAt"=blinkora_now() WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .execute(&mut *tx)
            .await?;
        if !old.is_reviewed {
            let mut flags = Map::new();
            flags.insert("isReviewed".to_string(), json!({ "before": false, "after": true }));
            let title = note_title(&old.content, id);
            insert_note_log_if_enabled_tx(
                &ctx,
                &mut tx,
                user,
                OperationLogDraft {
                    action: "markDailyReviewed".to_string(),
                    note_id: id,
                    note_type: old.note_type,
                    previous_note_type: Some(old.note_type),
                    note_title: title.clone(),
                    changed_fields: vec!["flags".to_string()],
                    summary: format!("Marked daily reviewed note: {title}"),
                    details: json!({ "flags": flags }),
                },
            )
            .await?;
        }
        tx.commit().await?;
        Ok(json!(true))
    }
    .boxed()
}

fn upsert(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        if user.is_workspace_agent() && input.get("attachments").is_some() {
            bail!("Agent token cannot modify attachments");
        }
        let id = input.get("id").and_then(Value::as_i64).map(|v| v as i32);
        let content = input.get("content").and_then(Value::as_str).map(str::to_owned);
        let note_type = input.get("type").and_then(Value::as_i64).map(|value| value as i32);
        let is_archived = input.get("isArchived").and_then(Value::as_bool);
        let is_recycle = input.get("isRecycle").and_then(Value::as_bool);
        let is_top = input.get("isTop").and_then(Value::as_bool);
        let is_reviewed = input.get("isReviewed").and_then(Value::as_bool);
        let metadata = input.get("metadata").cloned();
        let mut tx = ctx.state.pool().begin().await?;
        let (note_id, synced_content) = if let Some(id) = id {
            let old = note_snapshot_tx(&mut tx, id, user.id, ws).await?;
            if let Some(old) = old {
                let before_tags = note_tag_ids_tx(&mut tx, id).await?;
                let before_references = note_reference_ids_tx(&mut tx, id).await?;
                let version: i32 = sqlx::query_scalar(r#"SELECT COALESCE(MAX(version),0)+1 FROM "noteHistory" WHERE "noteId"=$1"#)
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
                sqlx::query(r#"INSERT INTO "noteHistory" ("noteId", content, metadata, version, "accountId", "workspaceId") VALUES ($1,$2,$3,$4,$5,$6)"#)
                    .bind(id)
                    .bind(&old.content)
                    .bind(old.metadata.clone())
                    .bind(version)
                    .bind(user.id)
                    .bind(ws)
                    .execute(&mut *tx)
                    .await?;
                let next_content = content.clone().unwrap_or_else(|| old.content.clone());
                let next_note_type = note_type.unwrap_or(old.note_type);
                let next_metadata = metadata.clone().or_else(|| old.metadata.clone());
                let next_is_recycle = is_recycle.unwrap_or(old.is_recycle);
                sqlx::query(r#"UPDATE notes SET content=$1, type=$2, metadata=COALESCE($3, metadata), "isArchived"=COALESCE($4, "isArchived"), "isRecycle"=COALESCE($5, "isRecycle"), "isTop"=COALESCE($6, "isTop"), "isReviewed"=COALESCE($7, "isReviewed"), "updatedAt"=blinkora_now() WHERE id=$8 AND "accountId"=$9 AND "workspaceId"=$10"#)
                    .bind(&next_content)
                    .bind(next_note_type)
                    .bind(metadata.clone())
                    .bind(is_archived)
                    .bind(is_recycle)
                    .bind(is_top)
                    .bind(is_reviewed)
                    .bind(id)
                    .bind(user.id)
                    .bind(ws)
                    .execute(&mut *tx)
                    .await?;
                sync_tags_for_recycle_state(
                    &ctx,
                    &mut tx,
                    id,
                    user.id,
                    ws,
                    &next_content,
                    next_is_recycle,
                )
                .await?;
                sync_references(&mut tx, id, user.id, ws, input.get("references")).await?;
                let after_tags = note_tag_ids_tx(&mut tx, id).await?;
                let after_references = note_reference_ids_tx(&mut tx, id).await?;

                let mut changed_fields = Vec::new();
                let mut details = Map::new();
                if old.content != next_content {
                    push_changed_field(&mut changed_fields, "content");
                    details.insert(
                        "content".to_string(),
                        content_change_detail(Some(&old.content), &next_content, Some(version)),
                    );
                }
                if old.note_type != next_note_type {
                    push_changed_field(&mut changed_fields, "type");
                    details.insert(
                        "type".to_string(),
                        json!({ "before": old.note_type, "after": next_note_type }),
                    );
                }
                if metadata.is_some() && old.metadata != next_metadata {
                    push_changed_field(&mut changed_fields, "metadata");
                    details.insert("metadata".to_string(), metadata_detail(&old.metadata, &next_metadata));
                }

                let mut flags = Map::new();
                add_flag_change(&mut flags, "isArchived", old.is_archived, is_archived);
                add_flag_change(&mut flags, "isRecycle", old.is_recycle, is_recycle);
                add_flag_change(&mut flags, "isTop", old.is_top, is_top);
                add_flag_change(&mut flags, "isReviewed", old.is_reviewed, is_reviewed);
                if !flags.is_empty() {
                    push_changed_field(&mut changed_fields, "flags");
                    details.insert("flags".to_string(), Value::Object(flags));
                }

                if before_tags != after_tags {
                    push_changed_field(&mut changed_fields, "tags");
                    details.insert("tags".to_string(), ids_diff_detail(&before_tags, &after_tags));
                }
                if input.get("references").is_some() && before_references != after_references {
                    push_changed_field(&mut changed_fields, "references");
                    details.insert(
                        "references".to_string(),
                        ids_diff_detail(&before_references, &after_references),
                    );
                }

                let action = action_for_update(&changed_fields, &details);
                let title = note_title(&next_content, id);
                insert_note_log_if_enabled_tx(
                    &ctx,
                    &mut tx,
                    user,
                    OperationLogDraft {
                        action,
                        note_id: id,
                        note_type: next_note_type,
                        previous_note_type: Some(old.note_type),
                        note_title: title.clone(),
                        changed_fields,
                        summary: format!("Updated note: {title}"),
                        details: Value::Object(details),
                    },
                )
                .await?;
                (id, next_content)
            } else {
                bail!("Note not found");
            }
        } else {
            let content = content.unwrap_or_default();
            let note_type = note_type.unwrap_or(0);
            let note_id: i32 = sqlx::query_scalar(r#"INSERT INTO notes (content, type, metadata, "isArchived", "isRecycle", "isTop", "isReviewed", "accountId", "workspaceId", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,blinkora_now()) RETURNING id"#)
                .bind(&content)
                .bind(note_type)
                .bind(metadata.clone())
                .bind(is_archived.unwrap_or(false))
                .bind(is_recycle.unwrap_or(false))
                .bind(is_top.unwrap_or(false))
                .bind(is_reviewed.unwrap_or(false))
                .bind(user.id)
                .bind(ws)
                .fetch_one(&mut *tx)
                .await?;
            sync_tags_for_recycle_state(
                &ctx,
                &mut tx,
                note_id,
                user.id,
                ws,
                &content,
                is_recycle.unwrap_or(false),
            )
            .await?;
            sync_references(&mut tx, note_id, user.id, ws, input.get("references")).await?;
            let after_tags = note_tag_ids_tx(&mut tx, note_id).await?;
            let after_references = note_reference_ids_tx(&mut tx, note_id).await?;

            let mut changed_fields = vec!["content".to_string(), "type".to_string()];
            let mut details = Map::new();
            details.insert("content".to_string(), content_change_detail(None, &content, None));
            details.insert("type".to_string(), json!({ "after": note_type }));
            if metadata.is_some() {
                push_changed_field(&mut changed_fields, "metadata");
                details.insert("metadata".to_string(), metadata_detail(&None, &metadata));
            }
            let mut flags = Map::new();
            add_flag_change(&mut flags, "isArchived", false, is_archived);
            add_flag_change(&mut flags, "isRecycle", false, is_recycle);
            add_flag_change(&mut flags, "isTop", false, is_top);
            add_flag_change(&mut flags, "isReviewed", false, is_reviewed);
            if !flags.is_empty() {
                push_changed_field(&mut changed_fields, "flags");
                details.insert("flags".to_string(), Value::Object(flags));
            }
            if !after_tags.is_empty() {
                push_changed_field(&mut changed_fields, "tags");
                details.insert("tags".to_string(), ids_diff_detail(&[], &after_tags));
            }
            if !after_references.is_empty() {
                push_changed_field(&mut changed_fields, "references");
                details.insert("references".to_string(), ids_diff_detail(&[], &after_references));
            }
            let title = note_title(&content, note_id);
            insert_note_log_if_enabled_tx(
                &ctx,
                &mut tx,
                user,
                OperationLogDraft {
                    action: "create".to_string(),
                    note_id,
                    note_type,
                    previous_note_type: None,
                    note_title: title.clone(),
                    changed_fields,
                    summary: format!("Created note: {title}"),
                    details: Value::Object(details),
                },
            )
            .await?;
            (note_id, content)
        };
        sync_attachments(&mut tx, note_id, user.id, ws, &synced_content, input.get("attachments")).await?;
        tx.commit().await?;
        let row = sqlx::query(&note_select_sql("id=$3"))
            .bind(user.id)
            .bind(ws)
            .bind(note_id)
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(note_json(&ctx, row).await?)
    }
    .boxed()
}

fn move_to_workspace(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        if user.is_workspace_agent() {
            bail!("Agent token is not allowed for this endpoint");
        }

        let source_workspace_id = workspace_id(&ctx).await?;
        let note_ids = unique_ids(&ids_from_input(&input));
        let target_workspace_id = input
            .get("targetWorkspaceId")
            .and_then(Value::as_i64)
            .unwrap_or_default() as i32;

        if note_ids.is_empty() {
            bail!("note id is required");
        }
        if target_workspace_id <= 0 {
            bail!("target workspace is required");
        }
        if target_workspace_id == source_workspace_id {
            bail!("cannot move note to current workspace");
        }

        let target_exists: Option<i32> =
            sqlx::query_scalar(r#"SELECT id FROM workspaces WHERE id=$1 AND "accountId"=$2"#)
                .bind(target_workspace_id)
                .bind(user.id)
                .fetch_optional(ctx.state.pool())
                .await?;
        if target_exists.is_none() {
            bail!("target workspace not found");
        }

        let mut tx = ctx.state.pool().begin().await?;
        let note_rows: Vec<(i32, String, bool)> = sqlx::query_as(
            r#"SELECT id, content, "isRecycle" FROM notes
               WHERE id IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3
               "#,
        )
        .bind(crate::db::json_array(&note_ids))
        .bind(user.id)
        .bind(source_workspace_id)
        .fetch_all(&mut *tx)
        .await?;

        if note_rows.len() != note_ids.len() {
            bail!("Note not found");
        }
        if note_rows.iter().any(|(_, _, is_recycle)| *is_recycle) {
            bail!("cannot move recycled note");
        }

        let source_tag_ids: Vec<i32> = sqlx::query_scalar(
            r#"SELECT DISTINCT "tagId" FROM "tagsToNote" WHERE "noteId" IN (SELECT value FROM json_each($1))"#,
        )
        .bind(crate::db::json_array(&note_ids))
        .fetch_all(&mut *tx)
        .await?;

        sqlx::query(
            r#"DELETE FROM "noteReference"
               WHERE ("fromNoteId" IN (SELECT value FROM json_each($1)) AND NOT ("toNoteId" IN (SELECT value FROM json_each($1))))
                  OR ("toNoteId" IN (SELECT value FROM json_each($1)) AND NOT ("fromNoteId" IN (SELECT value FROM json_each($1))))"#,
        )
        .bind(crate::db::json_array(&note_ids))
        .execute(&mut *tx)
        .await?;
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "noteId" IN (SELECT value FROM json_each($1))"#)
            .bind(crate::db::json_array(&note_ids))
            .execute(&mut *tx)
            .await?;
        super::tags::cleanup_unused_tags(&mut tx, &source_tag_ids, user.id, source_workspace_id)
            .await?;

        sqlx::query(
            r#"UPDATE notes
               SET "workspaceId"=$1, "updatedAt"=blinkora_now()
               WHERE id IN (SELECT value FROM json_each($2)) AND "accountId"=$3 AND "workspaceId"=$4"#,
        )
        .bind(target_workspace_id)
        .bind(crate::db::json_array(&note_ids))
        .bind(user.id)
        .bind(source_workspace_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"UPDATE attachments
               SET "workspaceId"=$1, "updatedAt"=blinkora_now()
               WHERE "noteId" IN (SELECT value FROM json_each($2)) AND "accountId"=$3 AND "workspaceId"=$4"#,
        )
        .bind(target_workspace_id)
        .bind(crate::db::json_array(&note_ids))
        .bind(user.id)
        .bind(source_workspace_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"UPDATE comments
               SET "workspaceId"=$1, "updatedAt"=blinkora_now()
               WHERE "noteId" IN (SELECT value FROM json_each($2)) AND "accountId"=$3 AND "workspaceId"=$4"#,
        )
        .bind(target_workspace_id)
        .bind(crate::db::json_array(&note_ids))
        .bind(user.id)
        .bind(source_workspace_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"UPDATE "noteHistory"
               SET "workspaceId"=$1
               WHERE "noteId" IN (SELECT value FROM json_each($2)) AND "accountId"=$3 AND "workspaceId"=$4"#,
        )
        .bind(target_workspace_id)
        .bind(crate::db::json_array(&note_ids))
        .bind(user.id)
        .bind(source_workspace_id)
        .execute(&mut *tx)
        .await?;

        for (note_id, content, _) in &note_rows {
            sync_tags(
                &ctx,
                &mut tx,
                *note_id,
                user.id,
                target_workspace_id,
                content,
            )
            .await?;
        }

        tx.commit().await?;

        Ok(json!({
            "success": true,
            "id": note_ids[0],
            "ids": note_ids,
            "count": note_rows.len(),
            "sourceWorkspaceId": source_workspace_id,
            "targetWorkspaceId": target_workspace_id
        }))
    }
    .boxed()
}

fn update_many(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let ids = ids_from_input(&input);
        if ids.is_empty() {
            return Ok(json!(true));
        }
        let is_archived = input.get("isArchived").and_then(Value::as_bool);
        let is_top = input.get("isTop").and_then(Value::as_bool);
        let is_reviewed = input.get("isReviewed").and_then(Value::as_bool);
        let mut tx = ctx.state.pool().begin().await?;
        let mut old_notes = Vec::new();
        for id in &ids {
            if let Some(note) = note_snapshot_tx(&mut tx, *id, user.id, ws).await? {
                old_notes.push(note);
            }
        }
        if let Some(value) = is_archived {
            sqlx::query(r#"UPDATE notes SET "isArchived"=$1, "updatedAt"=blinkora_now() WHERE id IN (SELECT value FROM json_each($2)) AND "accountId"=$3 AND "workspaceId"=$4"#)
                .bind(value).bind(crate::db::json_array(&ids)).bind(user.id).bind(ws).execute(&mut *tx).await?;
        }
        if let Some(value) = is_top {
            sqlx::query(r#"UPDATE notes SET "isTop"=$1, "updatedAt"=blinkora_now() WHERE id IN (SELECT value FROM json_each($2)) AND "accountId"=$3 AND "workspaceId"=$4"#)
                .bind(value).bind(crate::db::json_array(&ids)).bind(user.id).bind(ws).execute(&mut *tx).await?;
        }
        if let Some(value) = is_reviewed {
            sqlx::query(r#"UPDATE notes SET "isReviewed"=$1, "updatedAt"=blinkora_now() WHERE id IN (SELECT value FROM json_each($2)) AND "accountId"=$3 AND "workspaceId"=$4"#)
                .bind(value).bind(crate::db::json_array(&ids)).bind(user.id).bind(ws).execute(&mut *tx).await?;
        }
        for old in old_notes {
            let mut flags = Map::new();
            add_flag_change(&mut flags, "isArchived", old.is_archived, is_archived);
            add_flag_change(&mut flags, "isTop", old.is_top, is_top);
            add_flag_change(&mut flags, "isReviewed", old.is_reviewed, is_reviewed);
            if flags.is_empty() {
                continue;
            }
            let mut details = Map::new();
            details.insert("flags".to_string(), Value::Object(flags));
            let changed_fields = vec!["flags".to_string()];
            let action = action_for_update(&changed_fields, &details);
            let title = note_title(&old.content, old.id);
            insert_note_log_if_enabled_tx(
                &ctx,
                &mut tx,
                user,
                OperationLogDraft {
                    action,
                    note_id: old.id,
                    note_type: old.note_type,
                    previous_note_type: Some(old.note_type),
                    note_title: title.clone(),
                    changed_fields,
                    summary: format!("Updated note flags: {title}"),
                    details: Value::Object(details),
                },
            )
            .await?;
        }
        tx.commit().await?;
        Ok(json!(true))
    }
    .boxed()
}

fn trash_many(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    update_flag(ctx, input, "isRecycle", true)
}

fn delete_many(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let delete_orphan_attachments = input
            .get("deleteOrphanAttachments")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        delete_note_ids(ctx, ids_from_input(&input), delete_orphan_attachments).await
    }
    .boxed()
}

fn delete_impact(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let ids = ids_from_input(&input);
        let impact = get_delete_impact(&ctx, &ids).await?;
        let comments: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM comments WHERE "noteId" IN (SELECT value FROM json_each($1)) AND "workspaceId"=$2"#)
            .bind(crate::db::json_array(&impact.note_ids)).bind(ws).fetch_one(ctx.state.pool()).await.unwrap_or(0);
        let attachment_count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM attachments WHERE "noteId" IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(crate::db::json_array(&ids)).bind(user.id).bind(ws).fetch_one(ctx.state.pool()).await.unwrap_or(0);
        Ok(json!({
            "noteIds": impact.note_ids,
            "attachmentCount": attachment_count,
            "commentCount": comments,
            "totalAttachments": impact.candidates.len(),
            "orphanAttachments": impact.orphan_attachments_json()
        }))
    }
    .boxed()
}

fn add_reference(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let from = note_id_arg(&input, &["fromNoteId", "fromId"]);
        let to = note_id_arg(&input, &["toNoteId", "toId"]);
        if from <= 0 || to <= 0 || from == to {
            bail!("invalid reference");
        }
        ensure_notes_in_workspace(&ctx, &[from, to], user.id, ws, false).await?;
        let mut tx = ctx.state.pool().begin().await?;
        let Some(note) = note_snapshot_tx(&mut tx, from, user.id, ws).await? else {
            bail!("Note not found");
        };
        let before_references = note_reference_ids_tx(&mut tx, from).await?;
        sqlx::query(r#"INSERT INTO "noteReference" ("fromNoteId","toNoteId") VALUES ($1,$2) ON CONFLICT DO NOTHING"#)
            .bind(from).bind(to).execute(&mut *tx).await?;
        let after_references = note_reference_ids_tx(&mut tx, from).await?;
        if before_references != after_references {
            let title = note_title(&note.content, from);
            insert_note_log_if_enabled_tx(
                &ctx,
                &mut tx,
                user,
                OperationLogDraft {
                    action: "addReference".to_string(),
                    note_id: from,
                    note_type: note.note_type,
                    previous_note_type: Some(note.note_type),
                    note_title: title.clone(),
                    changed_fields: vec!["references".to_string()],
                    summary: format!("Added reference: {title}"),
                    details: json!({ "references": ids_diff_detail(&before_references, &after_references) }),
                },
            )
            .await?;
        }
        tx.commit().await?;
        Ok(json!({ "success": true, "fromNoteId": from, "toNoteId": to }))
    }
    .boxed()
}

fn remove_reference(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input
            .get("id")
            .and_then(Value::as_i64)
            .map(|value| value as i32);
        let mut from = note_id_arg(&input, &["fromNoteId", "fromId"]);
        let mut to = note_id_arg(&input, &["toNoteId", "toId"]);
        if let Some(id) = id {
            let row = sqlx::query(
                r#"SELECT nr."fromNoteId", nr."toNoteId"
                   FROM "noteReference" nr
                   JOIN notes nf ON nf.id=nr."fromNoteId"
                   JOIN notes nt ON nt.id=nr."toNoteId"
                   WHERE nr.id=$1
                     AND nf."accountId"=$2 AND nf."workspaceId"=$3
                     AND nt."accountId"=$2 AND nt."workspaceId"=$3"#,
            )
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .fetch_optional(ctx.state.pool())
            .await?;
            let Some(row) = row else {
                bail!("reference not found");
            };
            from = row.get::<i32, _>("fromNoteId");
            to = row.get::<i32, _>("toNoteId");
        }
        if from <= 0 || to <= 0 {
            bail!("id or fromNoteId/toNoteId is required");
        }
        ensure_notes_in_workspace(&ctx, &[from, to], user.id, ws, true).await?;
        let mut tx = ctx.state.pool().begin().await?;
        let Some(note) = note_snapshot_tx(&mut tx, from, user.id, ws).await? else {
            bail!("Note not found");
        };
        let before_references = note_reference_ids_tx(&mut tx, from).await?;
        let deleted = if let Some(id) = id {
            sqlx::query(r#"DELETE FROM "noteReference" WHERE id=$1"#)
                .bind(id)
                .execute(&mut *tx)
                .await?
                .rows_affected()
        } else {
            sqlx::query(r#"DELETE FROM "noteReference" WHERE "fromNoteId"=$1 AND "toNoteId"=$2"#)
                .bind(from)
                .bind(to)
                .execute(&mut *tx)
                .await?
                .rows_affected()
        };
        let after_references = note_reference_ids_tx(&mut tx, from).await?;
        if deleted > 0 && before_references != after_references {
            let title = note_title(&note.content, from);
            insert_note_log_if_enabled_tx(
                &ctx,
                &mut tx,
                user,
                OperationLogDraft {
                    action: "removeReference".to_string(),
                    note_id: from,
                    note_type: note.note_type,
                    previous_note_type: Some(note.note_type),
                    note_title: title.clone(),
                    changed_fields: vec!["references".to_string()],
                    summary: format!("Removed reference: {title}"),
                    details: json!({ "references": ids_diff_detail(&before_references, &after_references) }),
                },
            )
            .await?;
        }
        tx.commit().await?;
        Ok(json!({ "success": true, "deleted": deleted }))
    }
    .boxed()
}

fn set_references(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let from = note_id_arg(&input, &["fromNoteId", "fromId", "noteId", "id"]);
        if from <= 0 {
            bail!("fromNoteId is required");
        }
        ensure_notes_in_workspace(&ctx, &[from], user.id, ws, false).await?;
        let references = reference_ids_from_value(
            input
                .get("toNoteIds")
                .or_else(|| input.get("toIds"))
                .or_else(|| input.get("references"))
                .unwrap_or(&Value::Null),
        )
        .into_iter()
        .filter(|id| *id > 0 && *id != from)
        .collect::<Vec<_>>();
        let mut tx = ctx.state.pool().begin().await?;
        let Some(note) = note_snapshot_tx(&mut tx, from, user.id, ws).await? else {
            bail!("Note not found");
        };
        let before_references = note_reference_ids_tx(&mut tx, from).await?;
        sync_references(
            &mut tx,
            from,
            user.id,
            ws,
            Some(&Value::Array(
                references.iter().map(|id| json!(id)).collect(),
            )),
        )
        .await?;
        let after_references = note_reference_ids_tx(&mut tx, from).await?;
        if before_references != after_references {
            let title = note_title(&note.content, from);
            insert_note_log_if_enabled_tx(
                &ctx,
                &mut tx,
                user,
                OperationLogDraft {
                    action: "setReferences".to_string(),
                    note_id: from,
                    note_type: note.note_type,
                    previous_note_type: Some(note.note_type),
                    note_title: title.clone(),
                    changed_fields: vec!["references".to_string()],
                    summary: format!("Set references: {title}"),
                    details: json!({ "references": ids_diff_detail(&before_references, &after_references) }),
                },
            )
            .await?;
        }
        tx.commit().await?;
        let result = reference_list_for_note(&ctx, from, user.id, ws, false).await?;
        Ok(json!({ "success": true, "references": result }))
    }
    .boxed()
}

async fn sync_references<'a>(
    tx: &mut sqlx::Transaction<'a, sqlx::Sqlite>,
    from_note_id: i32,
    account_id: i32,
    workspace_id: i32,
    references_input: Option<&Value>,
) -> anyhow::Result<()> {
    let Some(value) = references_input else {
        return Ok(());
    };
    let references = reference_ids_from_value(value)
        .into_iter()
        .filter(|id| *id > 0 && *id != from_note_id)
        .collect::<Vec<_>>();

    sqlx::query(r#"DELETE FROM "noteReference" WHERE "fromNoteId"=$1"#)
        .bind(from_note_id)
        .execute(&mut **tx)
        .await?;

    if references.is_empty() {
        return Ok(());
    }

    let valid_targets: Vec<i32> = sqlx::query_scalar(
        r#"SELECT id FROM notes
           WHERE id IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3 AND "isRecycle"=false"#,
    )
    .bind(crate::db::json_array(&references))
    .bind(account_id)
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await?;
    let valid_targets = unique_ids(&valid_targets);
    if valid_targets.len() != unique_ids(&references).len() {
        bail!("one or more referenced notes were not found in this workspace");
    }

    for to_note_id in valid_targets {
        sqlx::query(r#"INSERT INTO "noteReference" ("fromNoteId","toNoteId") VALUES ($1,$2) ON CONFLICT DO NOTHING"#)
            .bind(from_note_id)
            .bind(to_note_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

fn note_id_arg(input: &Value, keys: &[&str]) -> i32 {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_i64))
        .unwrap_or_default() as i32
}

fn reference_ids_from_value(value: &Value) -> Vec<i32> {
    let mut seen = HashSet::new();
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.as_i64()
                    .or_else(|| item.get("id").and_then(Value::as_i64))
                    .or_else(|| item.get("toNoteId").and_then(Value::as_i64))
                    .or_else(|| item.get("toId").and_then(Value::as_i64))
            })
            .map(|id| id as i32)
            .filter(|id| seen.insert(*id))
            .collect(),
        Value::Number(value) => value.as_i64().map(|id| vec![id as i32]).unwrap_or_default(),
        _ => Vec::new(),
    }
}

async fn note_snapshot_tx(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    note_id: i32,
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<Option<NoteSnapshot>> {
    let row = sqlx::query(
        r#"SELECT id, content, type, metadata, "isArchived", "isRecycle", "isTop", "isReviewed"
           FROM notes WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#,
    )
    .bind(note_id)
    .bind(account_id)
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|row| NoteSnapshot {
        id: row.get::<i32, _>("id"),
        content: row.get::<String, _>("content"),
        note_type: row.get::<i32, _>("type"),
        metadata: row.get::<Option<Value>, _>("metadata"),
        is_archived: row.get::<bool, _>("isArchived"),
        is_recycle: row.get::<bool, _>("isRecycle"),
        is_top: row.get::<bool, _>("isTop"),
        is_reviewed: row.get::<bool, _>("isReviewed"),
    }))
}

async fn note_tag_ids_tx(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    note_id: i32,
) -> anyhow::Result<Vec<i32>> {
    let ids: Vec<i32> = sqlx::query_scalar(
        r#"SELECT "tagId" FROM "tagsToNote" WHERE "noteId"=$1 ORDER BY "tagId" ASC"#,
    )
    .bind(note_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(unique_ids(&ids))
}

async fn note_reference_ids_tx(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    note_id: i32,
) -> anyhow::Result<Vec<i32>> {
    let ids: Vec<i32> = sqlx::query_scalar(
        r#"SELECT "toNoteId" FROM "noteReference" WHERE "fromNoteId"=$1 ORDER BY "toNoteId" ASC"#,
    )
    .bind(note_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(unique_ids(&ids))
}

fn ids_diff_detail(before: &[i32], after: &[i32]) -> Value {
    let before = unique_ids(before);
    let after = unique_ids(after);
    let before_set = before.iter().copied().collect::<HashSet<_>>();
    let after_set = after.iter().copied().collect::<HashSet<_>>();
    let added = after
        .iter()
        .copied()
        .filter(|id| !before_set.contains(id))
        .collect::<Vec<_>>();
    let removed = before
        .iter()
        .copied()
        .filter(|id| !after_set.contains(id))
        .collect::<Vec<_>>();
    json!({
        "before": before,
        "after": after,
        "added": added,
        "removed": removed
    })
}

fn metadata_detail(before: &Option<Value>, after: &Option<Value>) -> Value {
    json!({
        "beforeHash": before.as_ref().map(metadata_hash),
        "afterHash": after.as_ref().map(metadata_hash),
        "beforeKeys": metadata_keys(before),
        "afterKeys": metadata_keys(after)
    })
}

fn metadata_hash(value: &Value) -> String {
    content_hash(&serde_json::to_string(value).unwrap_or_default())
}

fn metadata_keys(value: &Option<Value>) -> Vec<String> {
    value
        .as_ref()
        .and_then(Value::as_object)
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

fn add_flag_change(flags: &mut Map<String, Value>, name: &str, before: bool, after: Option<bool>) {
    if let Some(after) = after {
        if before != after {
            flags.insert(
                name.to_string(),
                json!({ "before": before, "after": after }),
            );
        }
    }
}

fn action_for_update(changed_fields: &[String], details: &Map<String, Value>) -> String {
    if changed_fields.len() == 1 && changed_fields[0] == "flags" {
        if let Some(flags) = details.get("flags").and_then(Value::as_object) {
            if let Some(value) = flags.get("isArchived").and_then(Value::as_object) {
                return if value.get("after").and_then(Value::as_bool).unwrap_or(false) {
                    "archive"
                } else {
                    "unarchive"
                }
                .to_string();
            }
            if let Some(value) = flags.get("isRecycle").and_then(Value::as_object) {
                return if value.get("after").and_then(Value::as_bool).unwrap_or(false) {
                    "recycle"
                } else {
                    "restore"
                }
                .to_string();
            }
            if let Some(value) = flags.get("isReviewed").and_then(Value::as_object) {
                return if value.get("after").and_then(Value::as_bool).unwrap_or(false) {
                    "markDailyReviewed"
                } else {
                    "markDailyUnreviewed"
                }
                .to_string();
            }
        }
    }
    "update".to_string()
}

fn push_changed_field(changed_fields: &mut Vec<String>, field: &str) {
    if !changed_fields.iter().any(|item| item == field) {
        changed_fields.push(field.to_string());
    }
}

async fn ensure_notes_in_workspace(
    ctx: &ProcedureContext,
    ids: &[i32],
    account_id: i32,
    workspace_id: i32,
    include_recycled: bool,
) -> anyhow::Result<()> {
    let mut connection = ctx.state.pool().acquire().await?;
    ensure_notes_in_workspace_with_connection(
        &mut connection,
        ids,
        account_id,
        workspace_id,
        include_recycled,
    )
    .await
}

async fn ensure_notes_in_workspace_with_connection(
    connection: &mut SqliteConnection,
    ids: &[i32],
    account_id: i32,
    workspace_id: i32,
    include_recycled: bool,
) -> anyhow::Result<()> {
    let ids = unique_ids(ids);
    if ids.is_empty() {
        bail!("note id is required");
    }
    let mut query = QueryBuilder::<Sqlite>::new(
        r#"SELECT COUNT(DISTINCT id) FROM notes WHERE id IN (SELECT value FROM json_each("#,
    );
    query.push_bind(crate::db::json_array(&ids));
    query
        .push(r#")) AND "accountId"="#)
        .push_bind(account_id)
        .push(r#" AND "workspaceId"="#)
        .push_bind(workspace_id);
    if !include_recycled {
        query.push(r#" AND "isRecycle"=false"#);
    }
    let count: i64 = query.build_query_scalar().fetch_one(connection).await?;
    if count as usize != ids.len() {
        bail!("one or more notes were not found in this workspace");
    }
    Ok(())
}

async fn reference_list_for_note(
    ctx: &ProcedureContext,
    id: i32,
    account_id: i32,
    workspace_id: i32,
    include_recycled_note: bool,
) -> anyhow::Result<Value> {
    let mut connection = ctx.state.pool().acquire().await?;
    reference_list_for_note_with_connection(
        &mut connection,
        id,
        account_id,
        workspace_id,
        include_recycled_note,
    )
    .await
}

async fn reference_list_for_note_with_connection(
    connection: &mut SqliteConnection,
    id: i32,
    account_id: i32,
    workspace_id: i32,
    include_recycled_note: bool,
) -> anyhow::Result<Value> {
    ensure_notes_in_workspace_with_connection(
        connection,
        &[id],
        account_id,
        workspace_id,
        include_recycled_note,
    )
    .await?;
    let rows = sqlx::query(
        r#"SELECT nr.id, nr."fromNoteId", nr."toNoteId", nr."createdAt",
                  fn.content AS "fromContent", fn."createdAt" AS "fromCreatedAt", fn."updatedAt" AS "fromUpdatedAt",
                  tn.content AS "toContent", tn."createdAt" AS "toCreatedAt", tn."updatedAt" AS "toUpdatedAt"
           FROM "noteReference" nr
           JOIN notes fn ON fn.id=nr."fromNoteId"
           JOIN notes tn ON tn.id=nr."toNoteId"
           WHERE (nr."fromNoteId"=$1 OR nr."toNoteId"=$1)
             AND fn."accountId"=$2 AND fn."workspaceId"=$3
             AND tn."accountId"=$2 AND tn."workspaceId"=$3
           ORDER BY nr."createdAt" DESC"#,
    )
    .bind(id)
    .bind(account_id)
    .bind(workspace_id)
    .fetch_all(connection)
    .await?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|row| {
                json!({
                    "id": row.get::<i32, _>("id"),
                    "fromNoteId": row.get::<i32, _>("fromNoteId"),
                    "toNoteId": row.get::<i32, _>("toNoteId"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
                    "fromNote": {
                        "id": row.get::<i32, _>("fromNoteId"),
                        "content": row.get::<String, _>("fromContent"),
                        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("fromCreatedAt"),
                        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("fromUpdatedAt")
                    },
                    "toNote": {
                        "id": row.get::<i32, _>("toNoteId"),
                        "content": row.get::<String, _>("toContent"),
                        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("toCreatedAt"),
                        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("toUpdatedAt")
                    }
                })
            })
            .collect(),
    ))
}

pub(crate) async fn note_references_json_with_connection(
    connection: &mut SqliteConnection,
    id: i32,
    account_id: i32,
    workspace_id: i32,
    include_recycled_note: bool,
) -> anyhow::Result<(Value, Value)> {
    let all = reference_list_for_note_with_connection(
        connection,
        id,
        account_id,
        workspace_id,
        include_recycled_note,
    )
    .await?;
    let items = all.as_array().cloned().unwrap_or_default();
    let references = items
        .iter()
        .filter(|item| item.get("fromNoteId").and_then(Value::as_i64) == Some(id as i64))
        .cloned()
        .collect::<Vec<_>>();
    let referenced_by = items
        .into_iter()
        .filter(|item| item.get("toNoteId").and_then(Value::as_i64) == Some(id as i64))
        .collect::<Vec<_>>();
    Ok((Value::Array(references), Value::Array(referenced_by)))
}

fn reference_list(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input
            .get("id")
            .or_else(|| input.get("noteId"))
            .and_then(Value::as_i64)
            .unwrap_or_default() as i32;
        reference_list_for_note(&ctx, id, user.id, ws, true).await
    }
    .boxed()
}

fn clear_recycle_bin(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let ids: Vec<i32> = sqlx::query_scalar(r#"SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2 AND "isRecycle"=true"#)
            .bind(user.id).bind(ws).fetch_all(ctx.state.pool()).await?;
        delete_note_ids(ctx, ids, true).await
    }
    .boxed()
}

fn update_attachments_order(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let mut tx = ctx.state.pool().begin().await?;
        if let Some(items) = input
            .get("attachments")
            .or_else(|| input.get("items"))
            .and_then(Value::as_array)
        {
            for item in items {
                let id = item.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
                let sort_order = item
                    .get("sortOrder")
                    .and_then(Value::as_i64)
                    .unwrap_or_default() as i32;
                sqlx::query(
                    r#"UPDATE attachments SET "sortOrder"=$1, "updatedAt"=blinkora_now()
                       WHERE id=$2 AND "accountId"=$3 AND "workspaceId"=$4"#,
                )
                .bind(sort_order)
                .bind(id)
                .bind(user.id)
                .bind(ws)
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(json!(true))
    }
    .boxed()
}

fn update_notes_order(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let mut tx = ctx.state.pool().begin().await?;
        if let Some(items) = input
            .get("notes")
            .or_else(|| input.get("items"))
            .and_then(Value::as_array)
        {
            for item in items {
                let id = item.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
                let sort_order = item
                    .get("sortOrder")
                    .and_then(Value::as_i64)
                    .unwrap_or_default() as i32;
                sqlx::query(
                    r#"UPDATE notes SET "sortOrder"=$1, "updatedAt"=blinkora_now()
                       WHERE id=$2 AND "accountId"=$3 AND "workspaceId"=$4"#,
                )
                .bind(sort_order)
                .bind(id)
                .bind(user.id)
                .bind(ws)
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(json!(true))
    }
    .boxed()
}

fn get_history(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let note_id = input.get("noteId").or_else(|| input.get("id")).and_then(Value::as_i64).unwrap_or_default() as i32;
        let rows = sqlx::query(r#"SELECT h.id, h."noteId", h.content, h.metadata, h.version, h."accountId", h."workspaceId", h."createdAt"
            FROM "noteHistory" h JOIN notes n ON n.id=h."noteId"
            WHERE h."noteId"=$1 AND n."accountId"=$2 AND n."workspaceId"=$3 ORDER BY h.version DESC"#)
            .bind(note_id).bind(user.id).bind(ws).fetch_all(ctx.state.pool()).await?;
        Ok(Value::Array(rows.into_iter().map(|row| json!({
            "id": row.get::<i32, _>("id"),
            "noteId": row.get::<i32, _>("noteId"),
            "content": row.get::<String, _>("content"),
            "metadata": row.get::<Option<Value>, _>("metadata"),
            "version": row.get::<i32, _>("version"),
            "accountId": row.get::<Option<i32>, _>("accountId"),
            "workspaceId": row.get::<Option<i32>, _>("workspaceId"),
            "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt")
        })).collect()))
    }.boxed()
}

fn get_version(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let note_id = input.get("noteId").or_else(|| input.get("id")).and_then(Value::as_i64).unwrap_or_default() as i32;
        let version = input.get("version").and_then(Value::as_i64).unwrap_or_default() as i32;
        let row = sqlx::query(r#"SELECT h.id, h."noteId", h.content, h.metadata, h.version, h."accountId", h."workspaceId", h."createdAt"
            FROM "noteHistory" h JOIN notes n ON n.id=h."noteId"
            WHERE h."noteId"=$1 AND h.version=$2 AND n."accountId"=$3 AND n."workspaceId"=$4"#)
            .bind(note_id).bind(version).bind(user.id).bind(ws).fetch_one(ctx.state.pool()).await?;
        Ok(json!({
            "id": row.get::<i32, _>("id"),
            "noteId": row.get::<i32, _>("noteId"),
            "content": row.get::<String, _>("content"),
            "metadata": row.get::<Option<Value>, _>("metadata"),
            "version": row.get::<i32, _>("version"),
            "accountId": row.get::<Option<i32>, _>("accountId"),
            "workspaceId": row.get::<Option<i32>, _>("workspaceId"),
            "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt")
        }))
    }.boxed()
}

fn update_flag(
    ctx: ProcedureContext,
    input: Value,
    field: &'static str,
    value: bool,
) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let ids = ids_from_input(&input);
        if !ids.is_empty() {
            let mut tx = ctx.state.pool().begin().await?;
            let mut old_notes = Vec::new();
            for id in &ids {
                if let Some(note) = note_snapshot_tx(&mut tx, *id, user.id, ws).await? {
                    old_notes.push(note);
                }
            }
            let sql = format!(r#"UPDATE notes SET "{field}"=$1, "updatedAt"=blinkora_now() WHERE id IN (SELECT value FROM json_each($2)) AND "accountId"=$3 AND "workspaceId"=$4"#);
            sqlx::query(&sql)
                .bind(value)
                .bind(crate::db::json_array(&ids))
                .bind(user.id)
                .bind(ws)
                .execute(&mut *tx)
                .await?;
            for old in old_notes {
                let before = match field {
                    "isArchived" => old.is_archived,
                    "isRecycle" => old.is_recycle,
                    "isTop" => old.is_top,
                    "isReviewed" => old.is_reviewed,
                    _ => value,
                };
                if before == value {
                    continue;
                }
                let before_tags = note_tag_ids_tx(&mut tx, old.id).await?;
                if field == "isRecycle" {
                    sync_tags_for_recycle_state(
                        &ctx,
                        &mut tx,
                        old.id,
                        user.id,
                        ws,
                        &old.content,
                        value,
                    )
                    .await?;
                }
                let after_tags = note_tag_ids_tx(&mut tx, old.id).await?;
                let mut flags = Map::new();
                flags.insert(field.to_string(), json!({ "before": before, "after": value }));
                let mut details = Map::new();
                details.insert("flags".to_string(), Value::Object(flags));
                let mut changed_fields = vec!["flags".to_string()];
                if before_tags != after_tags {
                    push_changed_field(&mut changed_fields, "tags");
                    details.insert("tags".to_string(), ids_diff_detail(&before_tags, &after_tags));
                }
                let action = action_for_update(&changed_fields, &details);
                let title = note_title(&old.content, old.id);
                insert_note_log_if_enabled_tx(
                    &ctx,
                    &mut tx,
                    user,
                    OperationLogDraft {
                        action,
                        note_id: old.id,
                        note_type: old.note_type,
                        previous_note_type: Some(old.note_type),
                        note_title: title.clone(),
                        changed_fields,
                        summary: format!("Updated note flag: {title}"),
                        details: Value::Object(details),
                    },
                )
                .await?;
            }
            tx.commit().await?;
        }
        Ok(json!(true))
    }.boxed()
}

fn ids_from_input(input: &Value) -> Vec<i32> {
    if let Some(items) = input.get("ids").and_then(Value::as_array) {
        return items
            .iter()
            .filter_map(|v| v.as_i64().map(|n| n as i32))
            .collect();
    }
    input
        .get("id")
        .and_then(Value::as_i64)
        .map(|id| vec![id as i32])
        .unwrap_or_default()
}

pub(crate) fn note_select_sql(extra: &str) -> String {
    format!(
        r#"SELECT id, type, content, "isArchived", "isRecycle", "isTop", "isReviewed", metadata, "accountId", "workspaceId", "sortOrder", "createdAt", "updatedAt"
           FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2 AND {extra}"#
    )
}

pub(crate) async fn sync_tags<'a>(
    _ctx: &ProcedureContext,
    tx: &mut sqlx::Transaction<'a, sqlx::Sqlite>,
    note_id: i32,
    account_id: i32,
    workspace_id: i32,
    content: &str,
) -> anyhow::Result<()> {
    let previous_tag_ids: Vec<i32> =
        sqlx::query_scalar(r#"SELECT "tagId" FROM "tagsToNote" WHERE "noteId"=$1"#)
            .bind(note_id)
            .fetch_all(&mut **tx)
            .await?;
    let tags = extract_hashtags(content);
    let mut current_ids = HashSet::new();
    for tag in tags {
        let mut parent = 0;
        for part in tag.trim_start_matches('#').split('/') {
            if part.is_empty() {
                continue;
            }
            let existing: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM tag WHERE name=$1 AND parent=$2 AND "accountId"=$3 AND "workspaceId"=$4"#)
                .bind(part).bind(parent).bind(account_id).bind(workspace_id).fetch_optional(&mut **tx).await?;
            let tag_id = match existing {
                Some(id) => id,
                None => sqlx::query_scalar(r#"INSERT INTO tag (name, parent, "accountId", "workspaceId", "updatedAt") VALUES ($1,$2,$3,$4,blinkora_now()) RETURNING id"#)
                    .bind(part).bind(parent).bind(account_id).bind(workspace_id).fetch_one(&mut **tx).await?,
            };
            sqlx::query(r#"INSERT INTO "tagsToNote" ("tagId","noteId") VALUES ($1,$2) ON CONFLICT DO NOTHING"#)
                .bind(tag_id).bind(note_id).execute(&mut **tx).await?;
            current_ids.insert(tag_id);
            parent = tag_id;
        }
    }
    if current_ids.is_empty() {
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "noteId"=$1"#)
            .bind(note_id)
            .execute(&mut **tx)
            .await?;
    } else {
        let ids: Vec<i32> = current_ids.into_iter().collect();
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "noteId"=$1 AND NOT ("tagId" IN (SELECT value FROM json_each($2)))"#)
            .bind(note_id)
            .bind(crate::db::json_array(&ids))
            .execute(&mut **tx)
            .await?;
    }
    super::tags::cleanup_unused_tags(tx, &previous_tag_ids, account_id, workspace_id).await?;
    Ok(())
}

async fn sync_tags_for_recycle_state<'a>(
    ctx: &ProcedureContext,
    tx: &mut sqlx::Transaction<'a, sqlx::Sqlite>,
    note_id: i32,
    account_id: i32,
    workspace_id: i32,
    content: &str,
    is_recycle: bool,
) -> anyhow::Result<()> {
    if is_recycle {
        clear_note_tags(tx, note_id, account_id, workspace_id).await
    } else {
        sync_tags(ctx, tx, note_id, account_id, workspace_id, content).await
    }
}

async fn clear_note_tags<'a>(
    tx: &mut sqlx::Transaction<'a, sqlx::Sqlite>,
    note_id: i32,
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<()> {
    let previous_tag_ids: Vec<i32> =
        sqlx::query_scalar(r#"SELECT "tagId" FROM "tagsToNote" WHERE "noteId"=$1"#)
            .bind(note_id)
            .fetch_all(&mut **tx)
            .await?;
    if previous_tag_ids.is_empty() {
        return Ok(());
    }
    sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "noteId"=$1"#)
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    super::tags::cleanup_unused_tags(tx, &previous_tag_ids, account_id, workspace_id).await?;
    Ok(())
}

async fn sync_attachments<'a>(
    tx: &mut sqlx::Transaction<'a, sqlx::Sqlite>,
    note_id: i32,
    account_id: i32,
    workspace_id: i32,
    content: &str,
    attachments_input: Option<&Value>,
) -> anyhow::Result<()> {
    let mut paths = extract_attachment_paths(content);
    if let Some(items) = attachments_input.and_then(Value::as_array) {
        for item in items {
            if let Some(path) = item
                .get("path")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                paths.insert(normalize_attachment_path(path));
            }
        }
    }
    if paths.is_empty() {
        return Ok(());
    }
    let paths: Vec<String> = paths.into_iter().collect();
    sqlx::query(
        r#"UPDATE attachments
           SET "noteId"=$1, "workspaceId"=$2, "updatedAt"=blinkora_now()
           WHERE path IN (SELECT value FROM json_each($3))
             AND (
               ("accountId"=$4 AND "workspaceId"=$2)
               OR ("accountId"=$4 AND "workspaceId" IS NULL AND "noteId" IS NULL)
               OR "noteId" IN (SELECT id FROM notes WHERE "accountId"=$4 AND "workspaceId"=$2)
             )"#,
    )
    .bind(note_id)
    .bind(workspace_id)
    .bind(crate::db::json_array(&paths))
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn extract_hashtags(content: &str) -> Vec<String> {
    let code_re = Regex::new("(?s)```.*?```").unwrap();
    let without_code = code_re.replace_all(content, "");
    let re = Regex::new(r"(?:^|[\s*_~`])(#[^\s#]+)").unwrap();
    let mut seen = HashSet::new();
    re.captures_iter(&without_code)
        .filter_map(|cap| cap.get(1).map(|m| normalize_hashtag(m.as_str())))
        .filter(|tag| tag.len() > 1)
        .filter(|tag| seen.insert(tag.clone()))
        .collect()
}

fn normalize_hashtag(tag: &str) -> String {
    let tag = match tag.find(is_hashtag_inline_delimiter) {
        Some(index) => &tag[..index],
        None => tag,
    };
    tag.trim_end_matches(is_hashtag_trailing_punctuation)
        .to_string()
}

fn is_hashtag_inline_delimiter(ch: char) -> bool {
    matches!(
        ch,
        '。' | '！'
            | '？'
            | '；'
            | '：'
            | '，'
            | '、'
            | '!'
            | '?'
            | ';'
            | ':'
            | ','
            | ')'
            | '）'
            | ']'
            | '】'
            | '》'
            | '>'
            | '"'
            | '\''
            | '”'
            | '’'
            | '*'
    )
}

fn is_hashtag_trailing_punctuation(ch: char) -> bool {
    matches!(
        ch,
        '。' | '！'
            | '？'
            | '；'
            | '：'
            | '，'
            | '、'
            | '.'
            | '!'
            | '?'
            | ';'
            | ':'
            | ','
            | ')'
            | '）'
            | ']'
            | '】'
            | '》'
            | '>'
            | '"'
            | '\''
            | '”'
            | '’'
            | '*'
    )
}

fn extract_attachment_paths(content: &str) -> HashSet<String> {
    let re = Regex::new(r#"/api/(?:s3)?file/[^\s"'<>]+"#).unwrap();
    re.find_iter(content)
        .map(|matched| normalize_attachment_path(matched.as_str()))
        .filter(|path| !path.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        extract_hashtags, get_history, get_version, update_attachments_order, update_notes_order,
    };
    use crate::handlers::test_support::HandlerTestFixture;
    use serde_json::{json, Value};

    #[test]
    fn extract_hashtags_trims_sentence_punctuation() {
        let content = "并把新卡标为 draft / #待审核。再关联 #方法, #项目/网络阅历；以及 #Node.js。";

        assert_eq!(
            extract_hashtags(content),
            vec!["#待审核", "#方法", "#项目/网络阅历", "#Node.js"]
        );
    }

    #[test]
    fn extract_hashtags_trims_markdown_emphasis_markers() {
        assert_eq!(extract_hashtags("正文 **#AI**"), vec!["#AI"]);
    }

    #[test]
    fn extract_hashtags_ignores_code_blocks_and_empty_tags() {
        let content = "保留 #方法。\n```md\n忽略 #代码。\n```\n过滤 #。 并保留 #观点！ #方法。";

        assert_eq!(extract_hashtags(content), vec!["#方法", "#观点"]);
    }

    #[tokio::test]
    async fn order_updates_are_atomic_and_workspace_scoped() {
        let fixture = HandlerTestFixture::new("order-isolation").await;
        let other_workspace = fixture.create_workspace("other").await;
        let note_one: i32 = sqlx::query_scalar(
            r#"INSERT INTO notes (content, "updatedAt", "accountId", "workspaceId")
               VALUES ('one', blinkora_now(), $1, $2) RETURNING id"#,
        )
        .bind(fixture.account_id)
        .bind(fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let note_two: i32 = sqlx::query_scalar(
            r#"INSERT INTO notes (content, "updatedAt", "accountId", "workspaceId")
               VALUES ('two', blinkora_now(), $1, $2) RETURNING id"#,
        )
        .bind(fixture.account_id)
        .bind(fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let other_note: i32 = sqlx::query_scalar(
            r#"INSERT INTO notes (content, "updatedAt", "accountId", "workspaceId")
               VALUES ('other', blinkora_now(), $1, $2) RETURNING id"#,
        )
        .bind(fixture.account_id)
        .bind(other_workspace)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let attachment_one: i32 = sqlx::query_scalar(
            r#"INSERT INTO attachments (name, path, "noteId", "accountId", "workspaceId", "updatedAt")
               VALUES ('one', 'one.txt', $1, $2, $3, blinkora_now()) RETURNING id"#,
        )
        .bind(note_one)
        .bind(fixture.account_id)
        .bind(fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let attachment_two: i32 = sqlx::query_scalar(
            r#"INSERT INTO attachments (name, path, "noteId", "accountId", "workspaceId", "updatedAt")
               VALUES ('two', 'two.txt', $1, $2, $3, blinkora_now()) RETURNING id"#,
        )
        .bind(note_two)
        .bind(fixture.account_id)
        .bind(fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let other_attachment: i32 = sqlx::query_scalar(
            r#"INSERT INTO attachments (name, path, "noteId", "accountId", "workspaceId", "updatedAt")
               VALUES ('other', 'other.txt', $1, $2, $3, blinkora_now()) RETURNING id"#,
        )
        .bind(other_note)
        .bind(fixture.account_id)
        .bind(other_workspace)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();

        sqlx::query(&format!(
            r#"CREATE TRIGGER fail_second_note_order BEFORE UPDATE OF "sortOrder" ON notes
               WHEN OLD.id={note_two} BEGIN SELECT RAISE(ABORT, 'forced note order failure'); END"#
        ))
        .execute(&fixture.pool)
        .await
        .unwrap();
        update_notes_order(
            fixture.ctx.clone(),
            json!({ "items": [
                { "id": note_one, "sortOrder": 10 },
                { "id": note_two, "sortOrder": 20 }
            ] }),
        )
        .await
        .expect_err("the second update must roll back the first");
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT SUM(\"sortOrder\") FROM notes")
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0
        );
        sqlx::query("DROP TRIGGER fail_second_note_order")
            .execute(&fixture.pool)
            .await
            .unwrap();

        update_notes_order(
            fixture.ctx.clone(),
            json!({ "items": [
                { "id": note_one, "sortOrder": 10 },
                { "id": other_note, "sortOrder": 99 }
            ] }),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT \"sortOrder\" FROM notes WHERE id=$1")
                .bind(note_one)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            10
        );
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT \"sortOrder\" FROM notes WHERE id=$1")
                .bind(other_note)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0
        );

        sqlx::query(&format!(
            r#"CREATE TRIGGER fail_second_attachment_order BEFORE UPDATE OF "sortOrder" ON attachments
               WHEN OLD.id={attachment_two} BEGIN SELECT RAISE(ABORT, 'forced attachment order failure'); END"#
        ))
        .execute(&fixture.pool)
        .await
        .unwrap();
        update_attachments_order(
            fixture.ctx.clone(),
            json!({ "items": [
                { "id": attachment_one, "sortOrder": 10 },
                { "id": attachment_two, "sortOrder": 20 }
            ] }),
        )
        .await
        .expect_err("the second attachment update must roll back the first");
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT SUM(\"sortOrder\") FROM attachments")
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0
        );
        sqlx::query("DROP TRIGGER fail_second_attachment_order")
            .execute(&fixture.pool)
            .await
            .unwrap();

        update_attachments_order(
            fixture.ctx.clone(),
            json!({ "items": [
                { "id": attachment_one, "sortOrder": 10 },
                { "id": other_attachment, "sortOrder": 99 }
            ] }),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT \"sortOrder\" FROM attachments WHERE id=$1")
                .bind(attachment_one)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            10
        );
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT \"sortOrder\" FROM attachments WHERE id=$1")
                .bind(other_attachment)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0
        );
        crate::db::probe(&fixture.pool).await.unwrap();
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn history_reads_are_workspace_scoped() {
        let fixture = HandlerTestFixture::new("history-isolation").await;
        let other_workspace = fixture.create_workspace("other").await;
        let note_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO notes (content, "updatedAt", "accountId", "workspaceId")
               VALUES ('main', blinkora_now(), $1, $2) RETURNING id"#,
        )
        .bind(fixture.account_id)
        .bind(fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let other_note_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO notes (content, "updatedAt", "accountId", "workspaceId")
               VALUES ('other', blinkora_now(), $1, $2) RETURNING id"#,
        )
        .bind(fixture.account_id)
        .bind(other_workspace)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        for (id, workspace, content) in [
            (note_id, fixture.workspace_id, "main-v1"),
            (other_note_id, other_workspace, "other-v1"),
        ] {
            sqlx::query(
                r#"INSERT INTO "noteHistory" ("noteId", content, version, "accountId", "workspaceId")
                   VALUES ($1, $2, 1, $3, $4)"#,
            )
            .bind(id)
            .bind(content)
            .bind(fixture.account_id)
            .bind(workspace)
            .execute(&fixture.pool)
            .await
            .unwrap();
        }

        let own = get_history(fixture.ctx.clone(), json!({ "noteId": note_id }))
            .await
            .unwrap();
        assert_eq!(own.as_array().map(Vec::len), Some(1));
        assert_eq!(own.pointer("/0/content"), Some(&json!("main-v1")));

        let other = get_history(fixture.ctx.clone(), json!({ "noteId": other_note_id }))
            .await
            .unwrap();
        assert_eq!(other, Value::Array(Vec::new()));
        get_version(
            fixture.ctx.clone(),
            json!({ "noteId": other_note_id, "version": 1 }),
        )
        .await
        .expect_err("history in another workspace must not be readable");
        fixture.cleanup().await;
    }
}

fn normalize_attachment_path(path: &str) -> String {
    let without_query = path.split(['?', '#']).next().unwrap_or(path);
    without_query
        .trim_end_matches(|ch: char| matches!(ch, ')' | ']' | ',' | '.' | ';' | ':' | '!' | '?'))
        .to_string()
}

#[derive(Clone)]
struct NoteForDelete {
    id: i32,
    note_type: i32,
    content: String,
}

#[derive(Clone)]
struct AttachmentForDelete {
    id: i32,
    name: String,
    path: String,
    mime_type: String,
}

struct DeleteImpact {
    note_ids: Vec<i32>,
    candidates: Vec<AttachmentForDelete>,
    orphan_attachment_ids: HashSet<i32>,
}

impl DeleteImpact {
    fn orphan_attachments_json(&self) -> Vec<Value> {
        self.candidates
            .iter()
            .filter(|attachment| self.orphan_attachment_ids.contains(&attachment.id))
            .map(|attachment| {
                json!({
                    "id": attachment.id,
                    "name": attachment.name,
                    "path": attachment.path,
                    "type": attachment.mime_type
                })
            })
            .collect()
    }
}

fn unique_ids(ids: &[i32]) -> Vec<i32> {
    let mut seen = HashSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}

async fn notes_for_delete(
    ctx: &ProcedureContext,
    ids: &[i32],
) -> anyhow::Result<(Vec<NoteForDelete>, i32, i32)> {
    let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
    let ws = workspace_id(&ctx).await?;
    let note_ids = unique_ids(ids);
    if note_ids.is_empty() {
        return Ok((Vec::new(), user.id, ws));
    }

    let rows = sqlx::query(
        r#"SELECT id, type, content FROM notes WHERE id IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3"#,
    )
    .bind(crate::db::json_array(&note_ids))
    .bind(user.id)
    .bind(ws)
    .fetch_all(ctx.state.pool())
    .await?;

    if rows.len() != note_ids.len() {
        bail!("Some notes cannot be deleted as you are not the owner");
    }

    let notes = rows
        .into_iter()
        .map(|row| NoteForDelete {
            id: row.get::<i32, _>("id"),
            note_type: row.get::<i32, _>("type"),
            content: row.get::<String, _>("content"),
        })
        .collect();
    Ok((notes, user.id, ws))
}

async fn attachment_delete_candidates(
    ctx: &ProcedureContext,
    notes: &[NoteForDelete],
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<Vec<AttachmentForDelete>> {
    let note_ids = notes.iter().map(|note| note.id).collect::<Vec<_>>();
    if note_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut by_id = HashMap::<i32, AttachmentForDelete>::new();
    let direct_rows =
        sqlx::query(r#"SELECT id, name, path, type FROM attachments WHERE "noteId" IN (SELECT value FROM json_each($1))"#)
            .bind(crate::db::json_array(&note_ids))
            .fetch_all(ctx.state.pool())
            .await?;

    for row in direct_rows {
        let attachment = AttachmentForDelete {
            id: row.get::<i32, _>("id"),
            name: row.get::<String, _>("name"),
            path: row.get::<String, _>("path"),
            mime_type: row.get::<String, _>("type"),
        };
        if !attachment.path.is_empty() {
            by_id.insert(attachment.id, attachment);
        }
    }

    let mut content_paths = HashSet::new();
    for note in notes {
        content_paths.extend(extract_attachment_paths(&note.content));
    }
    let content_paths = content_paths.into_iter().collect::<Vec<_>>();

    if !content_paths.is_empty() {
        let content_rows = sqlx::query(
            r#"SELECT id, name, path, type
               FROM attachments
               WHERE path IN (SELECT value FROM json_each($1))
                 AND (
                   ("accountId"=$2 AND "workspaceId"=$3)
                   OR ("accountId"=$2 AND "workspaceId" IS NULL AND "noteId" IS NULL)
                   OR "noteId" IN (SELECT id FROM notes WHERE "accountId"=$2 AND "workspaceId"=$3)
                 )"#,
        )
        .bind(crate::db::json_array(&content_paths))
        .bind(account_id)
        .bind(workspace_id)
        .fetch_all(ctx.state.pool())
        .await?;

        for row in content_rows {
            let attachment = AttachmentForDelete {
                id: row.get::<i32, _>("id"),
                name: row.get::<String, _>("name"),
                path: row.get::<String, _>("path"),
                mime_type: row.get::<String, _>("type"),
            };
            if !attachment.path.is_empty() {
                by_id.entry(attachment.id).or_insert(attachment);
            }
        }
    }

    Ok(by_id.into_values().collect())
}

async fn get_delete_impact(ctx: &ProcedureContext, ids: &[i32]) -> anyhow::Result<DeleteImpact> {
    let (notes, account_id, workspace_id) = notes_for_delete(ctx, ids).await?;
    let note_ids = notes.iter().map(|note| note.id).collect::<Vec<_>>();
    let candidates = attachment_delete_candidates(ctx, &notes, account_id, workspace_id).await?;
    let mut orphan_attachment_ids = HashSet::new();

    for attachment in &candidates {
        let other_reference_count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*)
               FROM notes n
               WHERE NOT (n.id IN (SELECT value FROM json_each($1)))
                 AND n."accountId"=$2
                 AND n."workspaceId"=$3
                 AND (
                   instr(n.content, $4) > 0
                   OR EXISTS (
                     SELECT 1 FROM attachments a
                     WHERE a."noteId"=n.id AND a.path=$4
                   )
                 )"#,
        )
        .bind(crate::db::json_array(&note_ids))
        .bind(account_id)
        .bind(workspace_id)
        .bind(&attachment.path)
        .fetch_one(ctx.state.pool())
        .await
        .unwrap_or(0);

        if other_reference_count == 0 {
            orphan_attachment_ids.insert(attachment.id);
        }
    }

    Ok(DeleteImpact {
        note_ids,
        candidates,
        orphan_attachment_ids,
    })
}

async fn delete_note_ids(
    ctx: ProcedureContext,
    ids: Vec<i32>,
    delete_orphan_attachments: bool,
) -> anyhow::Result<Value> {
    let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
    let (notes, account_id, workspace_id) = notes_for_delete(&ctx, &ids).await?;
    let ids = notes.iter().map(|note| note.id).collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(json!(true));
    }

    let impact = get_delete_impact(&ctx, &ids).await?;
    let attachments_to_delete = if delete_orphan_attachments {
        impact
            .candidates
            .iter()
            .filter(|attachment| impact.orphan_attachment_ids.contains(&attachment.id))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let mut unique_paths = HashSet::new();
    for attachment in &attachments_to_delete {
        if unique_paths.insert(attachment.path.clone()) {
            crate::attachment_files::delete_physical_attachment(&ctx, &attachment.path).await?;
        }
    }

    let attachment_ids_to_delete = attachments_to_delete
        .iter()
        .map(|attachment| attachment.id)
        .collect::<Vec<_>>();
    let mut tx = ctx.state.pool().begin().await?;
    let tag_ids_to_cleanup: Vec<i32> =
        sqlx::query_scalar(r#"SELECT DISTINCT "tagId" FROM "tagsToNote" WHERE "noteId" IN (SELECT value FROM json_each($1))"#)
            .bind(crate::db::json_array(&ids))
            .fetch_all(&mut *tx)
            .await?;
    for note in &notes {
        let title = note_title(&note.content, note.id);
        insert_note_log_if_enabled_tx(
            &ctx,
            &mut tx,
            user,
            OperationLogDraft {
                action: "delete".to_string(),
                note_id: note.id,
                note_type: note.note_type,
                previous_note_type: Some(note.note_type),
                note_title: title.clone(),
                changed_fields: vec!["note".to_string()],
                summary: format!("Deleted note: {title}"),
                details: json!({
                    "content": {
                        "beforeHash": content_hash(&note.content),
                        "beforeLength": note.content.chars().count()
                    },
                    "deleteOrphanAttachments": delete_orphan_attachments
                }),
            },
        )
        .await?;
    }
    for sql in [
        r#"DELETE FROM "tagsToNote" WHERE "noteId" IN (SELECT value FROM json_each($1))"#,
        r#"DELETE FROM "noteReference" WHERE "fromNoteId" IN (SELECT value FROM json_each($1)) OR "toNoteId" IN (SELECT value FROM json_each($1))"#,
        r#"DELETE FROM comments WHERE "noteId" IN (SELECT value FROM json_each($1))"#,
        r#"DELETE FROM "noteHistory" WHERE "noteId" IN (SELECT value FROM json_each($1))"#,
    ] {
        sqlx::query(sql)
            .bind(crate::db::json_array(&ids))
            .execute(&mut *tx)
            .await?;
    }
    super::tags::cleanup_unused_tags(&mut tx, &tag_ids_to_cleanup, account_id, workspace_id)
        .await?;

    if attachment_ids_to_delete.is_empty() {
        sqlx::query(
            r#"UPDATE attachments SET "noteId"=NULL, "updatedAt"=blinkora_now() WHERE "noteId" IN (SELECT value FROM json_each($1))"#,
        )
        .bind(crate::db::json_array(&ids))
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(r#"UPDATE attachments SET "noteId"=NULL, "updatedAt"=blinkora_now() WHERE "noteId" IN (SELECT value FROM json_each($1)) AND NOT (id IN (SELECT value FROM json_each($2)))"#)
            .bind(crate::db::json_array(&ids))
            .bind(crate::db::json_array(&attachment_ids_to_delete))
            .execute(&mut *tx)
            .await?;
        sqlx::query(r#"DELETE FROM attachments WHERE id IN (SELECT value FROM json_each($1))"#)
            .bind(crate::db::json_array(&attachment_ids_to_delete))
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query(r#"DELETE FROM notes WHERE id IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3"#)
        .bind(crate::db::json_array(&ids))
        .bind(account_id)
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!(true))
}
