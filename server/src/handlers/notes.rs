use super::common::{note_json, workspace_id};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use crate::util::unwrap_config_value;
use anyhow::{anyhow, bail};
use futures::FutureExt;
use regex::Regex;
use serde_json::{json, Value};
use sqlx::{Postgres, QueryBuilder, Row};
use std::collections::{HashMap, HashSet};

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("notes.list", list);
    registry.insert("notes.listByIds", list_by_ids);
    registry.insert("notes.detail", detail);
    registry.insert("notes.dailyReviewNoteList", daily_review);
    registry.insert("notes.randomNoteList", random_list);
    registry.insert("notes.reviewNote", review);
    registry.insert("notes.upsert", upsert);
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
        let is_use_ai_query = input.get("isUseAiQuery").and_then(Value::as_bool).unwrap_or(false);
        let cleaned_ai_search;
        let search = if is_use_ai_query {
            cleaned_ai_search = normalize_ai_query(raw_search);
            cleaned_ai_search.as_str()
        } else {
            raw_search
        };
        let ai_terms = if is_use_ai_query { ai_query_terms(search) } else { Vec::new() };
        let offset = (page - 1) * size;

        let vector_matches = if is_use_ai_query && !search.is_empty() {
            crate::rag::query_note_ids(ctx.state.pool(), search, user.id, ws, 1000.max(page * size)).await?
        } else {
            Vec::new()
        };
        let vector_match_by_id = vector_matches
            .iter()
            .enumerate()
            .map(|(idx, item)| (item.note_id, (idx, item.score)))
            .collect::<HashMap<_, _>>();
        let vector_ids = vector_matches.iter().map(|item| item.note_id).collect::<Vec<_>>();

        let mut query = QueryBuilder::<Postgres>::new(
            r#"SELECT n.id, n.type, n.content, n."isArchived", n."isRecycle", n."isTop", n."isReviewed", n.metadata,
                      n."accountId", n."workspaceId", n."sortOrder", n."createdAt", n."updatedAt"
               FROM notes n WHERE n."accountId"="#,
        );
        query.push_bind(user.id);
        query.push(r#" AND n."workspaceId"="#).push_bind(ws);
        query.push(r#" AND n."isRecycle"="#).push_bind(is_recycle);

        if !is_recycle {
            match is_archived {
                Some(Value::Null) => {}
                Some(Value::Bool(value)) => {
                    query.push(r#" AND n."isArchived"="#).push_bind(*value);
                }
                _ => {
                    query.push(r#" AND n."isArchived"="#).push_bind(false);
                }
            }
        }
        if note_type != -1 {
            query.push(" AND n.type=").push_bind(note_type as i32);
        }
        if let Some(tag_id) = tag_id {
            query
                .push(r#" AND EXISTS (SELECT 1 FROM "tagsToNote" ttn2 WHERE ttn2."noteId"=n.id AND ttn2."tagId"="#)
                .push_bind(tag_id)
                .push(")");
        }
        if with_file {
            query.push(r#" AND EXISTS (SELECT 1 FROM attachments a2 WHERE a2."noteId"=n.id)"#);
        }
        if without_tag {
            query.push(r#" AND NOT EXISTS (SELECT 1 FROM "tagsToNote" ttn3 WHERE ttn3."noteId"=n.id)"#);
        }
        if let Some(metadata_filter) = metadata_filter {
            query.push(r#" AND COALESCE(n.metadata::jsonb, '{}'::jsonb) @> "#);
            query.push_bind(metadata_filter);
            query.push("::jsonb");
        }
        if is_use_ai_query && (!ai_terms.is_empty() || !vector_ids.is_empty()) {
            query.push(" AND (");
            let mut has_condition = false;
            if !vector_ids.is_empty() {
                query.push("n.id=ANY(").push_bind(vector_ids.clone()).push(")");
                has_condition = true;
            }
            for (idx, term) in ai_terms.iter().enumerate() {
                if has_condition || idx > 0 {
                    query.push(" OR ");
                }
                let pattern = format!("%{term}%");
                query.push("n.content ILIKE ");
                query.push_bind(pattern.clone());
                query.push(r#" OR EXISTS (SELECT 1 FROM attachments a3 WHERE a3."noteId"=n.id AND a3.path ILIKE "#);
                query.push_bind(pattern);
                query.push(")");
                has_condition = true;
            }
            query.push(")");
        } else if !search.is_empty() {
            let pattern = format!("%{search}%");
            query.push(" AND (n.content ILIKE ");
            query.push_bind(pattern.clone());
            query.push(r#" OR EXISTS (SELECT 1 FROM attachments a3 WHERE a3."noteId"=n.id AND a3.path ILIKE "#);
            query.push_bind(pattern);
            query.push("))");
        }
        if with_link {
            query.push(" AND (n.content ILIKE '%http://%' OR n.content ILIKE '%https://%')");
        }
        if has_todo {
            query.push(" AND (n.content ILIKE '%- [ ]%' OR n.content ILIKE '%- [x]%' OR n.content ILIKE '%* [ ]%' OR n.content ILIKE '%* [x]%')");
        }
        if let (Some(start_date), Some(end_date)) = (start_date, end_date) {
            query.push(r#" AND n."createdAt" >= "#);
            query.push_bind(start_date.to_string());
            query.push(r#"::timestamptz AND n."createdAt" <= "#);
            query.push_bind(end_date.to_string());
            query.push("::timestamptz");
        }

        let time_order_column = if bool_config(&ctx, user.id, ws, "isOrderByCreateTime").await? {
            r#"n."createdAt""#
        } else {
            r#"n."updatedAt""#
        };
        query.push(r#" ORDER BY n."isTop" DESC, "#);
        if is_use_ai_query && !ai_terms.is_empty() {
            query.push("(");
            if !search.is_empty() {
                query.push("CASE WHEN n.content ILIKE ");
                query.push_bind(format!("%{search}%"));
                query.push(" THEN 100 ELSE 0 END + ");
            }
            for (idx, term) in ai_terms.iter().enumerate() {
                if idx > 0 {
                    query.push(" + ");
                }
                query.push("CASE WHEN n.content ILIKE ");
                query.push_bind(format!("%{term}%"));
                query.push(" THEN 10 ELSE 0 END");
                query.push(" + CASE WHEN EXISTS (SELECT 1 FROM attachments a_rank WHERE a_rank.\"noteId\"=n.id AND a_rank.path ILIKE ");
                query.push_bind(format!("%{term}%"));
                query.push(") THEN 5 ELSE 0 END");
            }
            query.push(") DESC, ");
        }
        query
            .push(r#"n."sortOrder" ASC, "#)
            .push(time_order_column)
            .push(" ")
            .push(order_dir);
        if !is_use_ai_query {
            query
                .push(" LIMIT ")
                .push_bind(size)
                .push(" OFFSET ")
                .push_bind(offset);
        }
        let rows = query.build().fetch_all(ctx.state.pool()).await?;
        let mut items = Vec::new();
        for row in rows {
            let id: i32 = row.get("id");
            let mut item = note_json(&ctx, row).await?;
            if is_use_ai_query {
                let content = item.get("content").and_then(Value::as_str).unwrap_or("");
                let keyword = keyword_score(content, &ai_terms, search);
                let vector = vector_match_by_id.get(&id).map(|(_, score)| *score).unwrap_or(0.0);
                item["score"] = json!(hybrid_score(keyword, vector));
            }
            items.push(item);
        }
        if is_use_ai_query {
            items.sort_by(|left, right| {
                right
                    .get("score")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    .partial_cmp(&left.get("score").and_then(Value::as_f64).unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        right
                            .get("isTop")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                            .cmp(&left.get("isTop").and_then(Value::as_bool).unwrap_or(false))
                    })
                    .then_with(|| {
                        left.get("sortOrder")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            .cmp(&right.get("sortOrder").and_then(Value::as_i64).unwrap_or(0))
                    })
            });
            let start = offset.max(0) as usize;
            let end = (start + size.max(0) as usize).min(items.len());
            items = if start < items.len() {
                items[start..end].to_vec()
            } else {
                Vec::new()
            };
        }
        Ok(Value::Array(items))
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
        let rows = sqlx::query(&note_select_sql("id=ANY($3)"))
            .bind(user.id)
            .bind(ws)
            .bind(&ids)
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
        sqlx::query(r#"UPDATE notes SET "isReviewed"=true, "updatedAt"=NOW() WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .execute(ctx.state.pool())
            .await?;
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
        let metadata = input.get("metadata").cloned();
        let mut tx = ctx.state.pool().begin().await?;
        let (note_id, synced_content) = if let Some(id) = id {
            let old: Option<(String, i32, Option<Value>)> = sqlx::query_as(r#"SELECT content, type, metadata FROM notes WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
                .bind(id)
                .bind(user.id)
                .bind(ws)
                .fetch_optional(&mut *tx)
                .await?;
            if let Some((old_content, old_note_type, old_metadata)) = old {
                let version: i32 = sqlx::query_scalar(r#"SELECT COALESCE(MAX(version),0)+1 FROM "noteHistory" WHERE "noteId"=$1"#)
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
                sqlx::query(r#"INSERT INTO "noteHistory" ("noteId", content, metadata, version, "accountId", "workspaceId") VALUES ($1,$2,$3,$4,$5,$6)"#)
                    .bind(id)
                    .bind(&old_content)
                    .bind(old_metadata)
                    .bind(version)
                    .bind(user.id)
                    .bind(ws)
                    .execute(&mut *tx)
                    .await?;
                let next_content = content.unwrap_or(old_content);
                let next_note_type = note_type.unwrap_or(old_note_type);
                sqlx::query(r#"UPDATE notes SET content=$1, type=$2, metadata=COALESCE($3::json, metadata), "updatedAt"=NOW() WHERE id=$4 AND "accountId"=$5 AND "workspaceId"=$6"#)
                    .bind(&next_content)
                    .bind(next_note_type)
                    .bind(metadata)
                    .bind(id)
                    .bind(user.id)
                    .bind(ws)
                    .execute(&mut *tx)
                    .await?;
                (id, next_content)
            } else {
                bail!("Note not found");
            }
        } else {
            let content = content.unwrap_or_default();
            let note_type = note_type.unwrap_or(0);
            sqlx::query_scalar(r#"INSERT INTO notes (content, type, metadata, "accountId", "workspaceId", "updatedAt") VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id"#)
                .bind(&content)
                .bind(note_type)
                .bind(metadata)
                .bind(user.id)
                .bind(ws)
                .fetch_one(&mut *tx)
                .await
                .map(|id| (id, content))?
        };
        sync_tags(&ctx, &mut tx, note_id, user.id, ws, &synced_content).await?;
        sync_references(&mut tx, note_id, user.id, ws, input.get("references")).await?;
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
        if let Some(value) = is_archived {
            sqlx::query(r#"UPDATE notes SET "isArchived"=$1, "updatedAt"=NOW() WHERE id=ANY($2) AND "accountId"=$3 AND "workspaceId"=$4"#)
                .bind(value).bind(&ids).bind(user.id).bind(ws).execute(ctx.state.pool()).await?;
        }
        if let Some(value) = is_top {
            sqlx::query(r#"UPDATE notes SET "isTop"=$1, "updatedAt"=NOW() WHERE id=ANY($2) AND "accountId"=$3 AND "workspaceId"=$4"#)
                .bind(value).bind(&ids).bind(user.id).bind(ws).execute(ctx.state.pool()).await?;
        }
        if let Some(value) = is_reviewed {
            sqlx::query(r#"UPDATE notes SET "isReviewed"=$1, "updatedAt"=NOW() WHERE id=ANY($2) AND "accountId"=$3 AND "workspaceId"=$4"#)
                .bind(value).bind(&ids).bind(user.id).bind(ws).execute(ctx.state.pool()).await?;
        }
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
        let comments: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM comments WHERE "noteId"=ANY($1) AND "workspaceId"=$2"#)
            .bind(&impact.note_ids).bind(ws).fetch_one(ctx.state.pool()).await.unwrap_or(0);
        let attachment_count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM attachments WHERE "noteId"=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(&ids).bind(user.id).bind(ws).fetch_one(ctx.state.pool()).await.unwrap_or(0);
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
        ensure_notes_in_workspace(&ctx, &[from, to], user.id, ws).await?;
        sqlx::query(r#"INSERT INTO "noteReference" ("fromNoteId","toNoteId") VALUES ($1,$2) ON CONFLICT DO NOTHING"#)
            .bind(from).bind(to).execute(ctx.state.pool()).await?;
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
        let from = note_id_arg(&input, &["fromNoteId", "fromId"]);
        let to = note_id_arg(&input, &["toNoteId", "toId"]);
        let deleted = if let Some(id) = id {
            sqlx::query(
                r#"DELETE FROM "noteReference" nr
                   USING notes nf, notes nt
                   WHERE nr.id=$1
                     AND nf.id=nr."fromNoteId"
                     AND nt.id=nr."toNoteId"
                     AND nf."accountId"=$2 AND nf."workspaceId"=$3
                     AND nt."accountId"=$2 AND nt."workspaceId"=$3"#,
            )
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .execute(ctx.state.pool())
            .await?
            .rows_affected()
        } else {
            if from <= 0 || to <= 0 {
                bail!("id or fromNoteId/toNoteId is required");
            }
            ensure_notes_in_workspace(&ctx, &[from, to], user.id, ws).await?;
            sqlx::query(r#"DELETE FROM "noteReference" WHERE "fromNoteId"=$1 AND "toNoteId"=$2"#)
                .bind(from)
                .bind(to)
                .execute(ctx.state.pool())
                .await?
                .rows_affected()
        };
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
        ensure_notes_in_workspace(&ctx, &[from], user.id, ws).await?;
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
        tx.commit().await?;
        let result = reference_list_for_note(&ctx, from, user.id, ws).await?;
        Ok(json!({ "success": true, "references": result }))
    }
    .boxed()
}

async fn sync_references<'a>(
    tx: &mut sqlx::Transaction<'a, sqlx::Postgres>,
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
           WHERE id=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3 AND "isRecycle"=false"#,
    )
    .bind(&references)
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

async fn ensure_notes_in_workspace(
    ctx: &ProcedureContext,
    ids: &[i32],
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<()> {
    let ids = unique_ids(ids);
    if ids.is_empty() {
        bail!("note id is required");
    }
    let count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT id) FROM notes
           WHERE id=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3 AND "isRecycle"=false"#,
    )
    .bind(&ids)
    .bind(account_id)
    .bind(workspace_id)
    .fetch_one(ctx.state.pool())
    .await?;
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
) -> anyhow::Result<Value> {
    ensure_notes_in_workspace(ctx, &[id], account_id, workspace_id).await?;
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
    .fetch_all(ctx.state.pool())
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

pub(crate) async fn note_references_json(
    ctx: &ProcedureContext,
    id: i32,
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<(Value, Value)> {
    let all = reference_list_for_note(ctx, id, account_id, workspace_id).await?;
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
        reference_list_for_note(&ctx, id, user.id, ws).await
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
                    r#"UPDATE attachments SET "sortOrder"=$1, "updatedAt"=NOW() WHERE id=$2"#,
                )
                .bind(sort_order)
                .bind(id)
                .execute(ctx.state.pool())
                .await?;
            }
        }
        Ok(json!(true))
    }
    .boxed()
}

fn update_notes_order(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
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
                sqlx::query(r#"UPDATE notes SET "sortOrder"=$1, "updatedAt"=NOW() WHERE id=$2"#)
                    .bind(sort_order)
                    .bind(id)
                    .execute(ctx.state.pool())
                    .await?;
            }
        }
        Ok(json!(true))
    }
    .boxed()
}

fn get_history(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let note_id = input.get("noteId").or_else(|| input.get("id")).and_then(Value::as_i64).unwrap_or_default() as i32;
        let rows = sqlx::query(r#"SELECT id, "noteId", content, metadata, version, "accountId", "workspaceId", "createdAt" FROM "noteHistory" WHERE "noteId"=$1 ORDER BY version DESC"#)
            .bind(note_id).fetch_all(ctx.state.pool()).await?;
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
        let note_id = input.get("noteId").or_else(|| input.get("id")).and_then(Value::as_i64).unwrap_or_default() as i32;
        let version = input.get("version").and_then(Value::as_i64).unwrap_or_default() as i32;
        let row = sqlx::query(r#"SELECT id, "noteId", content, metadata, version, "accountId", "workspaceId", "createdAt" FROM "noteHistory" WHERE "noteId"=$1 AND version=$2"#)
            .bind(note_id).bind(version).fetch_one(ctx.state.pool()).await?;
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
            let sql = format!(r#"UPDATE notes SET "{field}"=$1, "updatedAt"=NOW() WHERE id=ANY($2) AND "accountId"=$3 AND "workspaceId"=$4"#);
            sqlx::query(&sql).bind(value).bind(&ids).bind(user.id).bind(ws).execute(ctx.state.pool()).await?;
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

async fn sync_tags<'a>(
    _ctx: &ProcedureContext,
    tx: &mut sqlx::Transaction<'a, sqlx::Postgres>,
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
                None => sqlx::query_scalar(r#"INSERT INTO tag (name, parent, "accountId", "workspaceId", "updatedAt") VALUES ($1,$2,$3,$4,NOW()) RETURNING id"#)
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
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "noteId"=$1 AND NOT ("tagId"=ANY($2))"#)
            .bind(note_id)
            .bind(&ids)
            .execute(&mut **tx)
            .await?;
    }
    cleanup_unused_tags(tx, &previous_tag_ids, account_id, workspace_id).await?;
    Ok(())
}

async fn cleanup_unused_tags<'a>(
    tx: &mut sqlx::Transaction<'a, sqlx::Postgres>,
    tag_ids: &[i32],
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<()> {
    let tag_ids = unique_ids(tag_ids);
    if tag_ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        r#"DELETE FROM tag t
           WHERE t.id=ANY($1)
             AND t."accountId"=$2
             AND t."workspaceId"=$3
             AND NOT EXISTS (
               SELECT 1 FROM "tagsToNote" ttn WHERE ttn."tagId"=t.id
             )"#,
    )
    .bind(&tag_ids)
    .bind(account_id)
    .bind(workspace_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn sync_attachments<'a>(
    tx: &mut sqlx::Transaction<'a, sqlx::Postgres>,
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
           SET "noteId"=$1, "workspaceId"=$2, "updatedAt"=NOW()
           WHERE path=ANY($3)
             AND (
               ("accountId"=$4 AND "workspaceId"=$2)
               OR ("accountId"=$4 AND "workspaceId" IS NULL AND "noteId" IS NULL)
               OR "noteId" IN (SELECT id FROM notes WHERE "accountId"=$4 AND "workspaceId"=$2)
             )"#,
    )
    .bind(note_id)
    .bind(workspace_id)
    .bind(&paths)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn extract_hashtags(content: &str) -> Vec<String> {
    let code_re = Regex::new("(?s)```.*?```").unwrap();
    let without_code = code_re.replace_all(content, "");
    let re = Regex::new(r"(?:^|\s)(#[^\s#]+)").unwrap();
    let mut seen = HashSet::new();
    re.captures_iter(&without_code)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .filter(|tag| seen.insert(tag.clone()))
        .collect()
}

fn extract_attachment_paths(content: &str) -> HashSet<String> {
    let re = Regex::new(r#"/api/(?:s3)?file/[^\s"'<>]+"#).unwrap();
    re.find_iter(content)
        .map(|matched| normalize_attachment_path(matched.as_str()))
        .filter(|path| !path.is_empty())
        .collect()
}

fn normalize_ai_query(query: &str) -> String {
    query
        .replace('@', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn ai_query_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .split(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    ',' | '.'
                        | ';'
                        | ':'
                        | '!'
                        | '?'
                        | '"'
                        | '\''
                        | '('
                        | ')'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                )
        })
        .map(str::trim)
        .filter(|term| term.chars().count() >= 2)
        .map(str::to_lowercase)
        .filter(|term| seen.insert(term.clone()))
        .take(12)
        .collect()
}

fn keyword_score(content: &str, terms: &[String], search: &str) -> f64 {
    let lower = content.to_lowercase();
    let mut score = 0.0;
    if !search.is_empty() && lower.contains(&search.to_lowercase()) {
        score += 1.0;
    }
    for term in terms {
        if lower.contains(term) {
            score += 0.1;
        }
    }
    score
}

fn hybrid_score(keyword_score: f64, vector_score: f64) -> f64 {
    keyword_score * 10.0 + vector_score
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
        r#"SELECT id, content FROM notes WHERE id=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3"#,
    )
    .bind(&note_ids)
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
        sqlx::query(r#"SELECT id, name, path, type FROM attachments WHERE "noteId"=ANY($1)"#)
            .bind(&note_ids)
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
               WHERE path=ANY($1)
                 AND (
                   ("accountId"=$2 AND "workspaceId"=$3)
                   OR ("accountId"=$2 AND "workspaceId" IS NULL AND "noteId" IS NULL)
                   OR "noteId" IN (SELECT id FROM notes WHERE "accountId"=$2 AND "workspaceId"=$3)
                 )"#,
        )
        .bind(&content_paths)
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
               WHERE NOT (n.id=ANY($1))
                 AND n."accountId"=$2
                 AND n."workspaceId"=$3
                 AND (
                   POSITION($4 IN n.content) > 0
                   OR EXISTS (
                     SELECT 1 FROM attachments a
                     WHERE a."noteId"=n.id AND a.path=$4
                   )
                 )"#,
        )
        .bind(&note_ids)
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
        sqlx::query_scalar(r#"SELECT DISTINCT "tagId" FROM "tagsToNote" WHERE "noteId"=ANY($1)"#)
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?;
    for sql in [
        r#"DELETE FROM "tagsToNote" WHERE "noteId"=ANY($1)"#,
        r#"DELETE FROM "noteReference" WHERE "fromNoteId"=ANY($1) OR "toNoteId"=ANY($1)"#,
        r#"DELETE FROM comments WHERE "noteId"=ANY($1)"#,
        r#"DELETE FROM "noteHistory" WHERE "noteId"=ANY($1)"#,
    ] {
        sqlx::query(sql).bind(&ids).execute(&mut *tx).await?;
    }
    cleanup_unused_tags(&mut tx, &tag_ids_to_cleanup, account_id, workspace_id).await?;

    if attachment_ids_to_delete.is_empty() {
        sqlx::query(
            r#"UPDATE attachments SET "noteId"=NULL, "updatedAt"=NOW() WHERE "noteId"=ANY($1)"#,
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(r#"UPDATE attachments SET "noteId"=NULL, "updatedAt"=NOW() WHERE "noteId"=ANY($1) AND NOT (id=ANY($2))"#)
            .bind(&ids)
            .bind(&attachment_ids_to_delete)
            .execute(&mut *tx)
            .await?;
        sqlx::query(r#"DELETE FROM attachments WHERE id=ANY($1)"#)
            .bind(&attachment_ids_to_delete)
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query(r#"DELETE FROM notes WHERE id=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3"#)
        .bind(&ids)
        .bind(account_id)
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::rag::delete_note_vectors(ctx.state.pool(), &ids, account_id, workspace_id).await?;
    Ok(json!(true))
}
