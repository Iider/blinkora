use super::common::{tag_json, workspace_id};
use super::operation_logs::{
    content_change_detail, insert_note_log_if_enabled_tx, note_title, OperationLogDraft,
};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use sqlx::Sqlite;
use std::collections::{HashMap, HashSet};

const DEFAULT_ORPHAN_TAG_CLEANUP_LIMIT: usize = 200;
const MAX_ORPHAN_TAG_CLEANUP_LIMIT: usize = 1000;
const INTERNAL_ORPHAN_TAG_CLEANUP_LIMIT: usize = 10_000;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("tags.list", list);
    registry.insert("tags.fullTagNameById", full_name);
    registry.insert("tags.cleanupOrphanTags", cleanup_orphan);
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

fn cleanup_orphan(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let tag_ids = tag_ids_from_input(&input);
        let all = input.get("all").and_then(Value::as_bool).unwrap_or(false);
        let dry_run = input.get("dryRun").and_then(Value::as_bool).unwrap_or(true);
        if !dry_run && !all && tag_ids.is_empty() {
            bail!("cleanupOrphanTags requires tagIds or all=true when dryRun=false");
        }

        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_ORPHAN_TAG_CLEANUP_LIMIT)
            .clamp(1, MAX_ORPHAN_TAG_CLEANUP_LIMIT);

        let options = OrphanTagCleanupOptions {
            tag_ids,
            all,
            dry_run,
            limit,
        };
        let mut tx = ctx.state.pool().begin().await?;
        let result = cleanup_orphan_tags_tx(&mut tx, user.id, ws, options).await?;
        tx.commit().await?;
        Ok(result)
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
        let rows = sqlx::query(r#"SELECT id, type, content FROM notes WHERE id IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(crate::db::json_array(&ids))
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
            sqlx::query(r#"UPDATE notes SET content=$1, "updatedAt"=blinkora_now() WHERE id=$2"#)
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

#[derive(Debug, Clone)]
pub(crate) struct OrphanTagCleanupOptions {
    pub tag_ids: Vec<i32>,
    pub all: bool,
    pub dry_run: bool,
    pub limit: usize,
}

#[derive(Debug, Clone)]
struct TagNode {
    id: i32,
    name: String,
    parent: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkippedTag {
    id: i32,
    reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OrphanTagCleanupPlan {
    candidate_ids: Vec<i32>,
    skipped: Vec<SkippedTag>,
    remaining_orphan_count: usize,
}

pub(crate) async fn cleanup_unused_tags<'a>(
    tx: &mut sqlx::Transaction<'a, Sqlite>,
    tag_ids: &[i32],
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<()> {
    if tag_ids.is_empty() {
        return Ok(());
    }
    cleanup_orphan_tags_tx(
        tx,
        account_id,
        workspace_id,
        OrphanTagCleanupOptions {
            tag_ids: tag_ids.to_vec(),
            all: false,
            dry_run: false,
            limit: INTERNAL_ORPHAN_TAG_CLEANUP_LIMIT,
        },
    )
    .await?;
    Ok(())
}

pub(crate) async fn cleanup_orphan_tags_tx<'a>(
    tx: &mut sqlx::Transaction<'a, Sqlite>,
    account_id: i32,
    workspace_id: i32,
    options: OrphanTagCleanupOptions,
) -> anyhow::Result<Value> {
    let tag_rows = sqlx::query(
        r#"SELECT id, name, parent
           FROM tag
           WHERE "accountId"=$1 AND "workspaceId"=$2
           ORDER BY id ASC"#,
    )
    .bind(account_id)
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await?;
    let tags = tag_rows
        .into_iter()
        .map(|row| TagNode {
            id: row.get("id"),
            name: row.get("name"),
            parent: row.get("parent"),
        })
        .collect::<Vec<_>>();
    let referenced_tag_ids = sqlx::query_scalar(
        r#"SELECT DISTINCT ttn."tagId"
           FROM "tagsToNote" ttn
           JOIN tag t ON t.id=ttn."tagId"
           WHERE t."accountId"=$1 AND t."workspaceId"=$2"#,
    )
    .bind(account_id)
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect::<HashSet<i32>>();

    let scan_all = options.all || (options.dry_run && options.tag_ids.is_empty());
    let plan = plan_orphan_tag_cleanup(
        &tags,
        &referenced_tag_ids,
        &options.tag_ids,
        scan_all,
        options.limit.max(1),
    );
    if !options.dry_run && !plan.candidate_ids.is_empty() {
        sqlx::query(r#"DELETE FROM tag WHERE id IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(crate::db::json_array(&plan.candidate_ids))
            .bind(account_id)
            .bind(workspace_id)
            .execute(&mut **tx)
            .await?;
    }

    let by_id = tag_map(&tags);
    let candidates = tag_list_json(&by_id, &plan.candidate_ids, None);
    let deleted = if options.dry_run {
        Vec::new()
    } else {
        tag_list_json(&by_id, &plan.candidate_ids, None)
    };
    let skipped = plan
        .skipped
        .iter()
        .filter_map(|item| {
            by_id
                .get(&item.id)
                .map(|tag| tag_to_json(&by_id, tag, Some(item.reason)))
                .or_else(|| {
                    Some(json!({
                        "id": item.id,
                        "reason": item.reason
                    }))
                })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "success": true,
        "dryRun": options.dry_run,
        "all": scan_all,
        "limit": options.limit,
        "candidates": candidates,
        "deleted": deleted,
        "skipped": skipped,
        "remainingOrphanCount": plan.remaining_orphan_count
    }))
}

fn plan_orphan_tag_cleanup(
    tags: &[TagNode],
    referenced_tag_ids: &HashSet<i32>,
    requested_tag_ids: &[i32],
    scan_all: bool,
    limit: usize,
) -> OrphanTagCleanupPlan {
    let by_id = tag_map(tags);
    let mut scope = if scan_all {
        tags.iter().map(|tag| tag.id).collect::<HashSet<_>>()
    } else {
        let mut scope = HashSet::new();
        for id in unique_ids(requested_tag_ids) {
            let Some(tag) = by_id.get(&id) else {
                continue;
            };
            scope.insert(tag.id);
            let mut parent = tag.parent;
            while parent > 0 {
                let Some(parent_tag) = by_id.get(&parent) else {
                    break;
                };
                scope.insert(parent_tag.id);
                parent = parent_tag.parent;
            }
        }
        scope
    };
    scope.retain(|id| by_id.contains_key(id));

    let requested_set = unique_ids(requested_tag_ids)
        .into_iter()
        .collect::<HashSet<_>>();
    let mut skipped = requested_set
        .iter()
        .filter(|id| !by_id.contains_key(id))
        .map(|id| SkippedTag {
            id: *id,
            reason: "notFound",
        })
        .collect::<Vec<_>>();
    let child_map = child_map(tags);
    let depth_map = depth_map(tags);
    let limit = limit.max(1);
    let mut deleted_ids = HashSet::new();
    let mut candidate_ids = Vec::new();

    while candidate_ids.len() < limit {
        let mut pass = scope
            .iter()
            .copied()
            .filter(|id| !deleted_ids.contains(id))
            .filter(|id| tag_is_orphan_leaf(*id, &child_map, referenced_tag_ids, &deleted_ids))
            .collect::<Vec<_>>();
        pass.sort_by(|left, right| {
            depth_map
                .get(right)
                .unwrap_or(&0)
                .cmp(depth_map.get(left).unwrap_or(&0))
                .then_with(|| left.cmp(right))
        });
        if pass.is_empty() {
            break;
        }
        for id in pass {
            if candidate_ids.len() >= limit {
                break;
            }
            deleted_ids.insert(id);
            candidate_ids.push(id);
        }
    }

    for id in requested_set.iter().filter(|id| by_id.contains_key(id)) {
        if deleted_ids.contains(id) {
            continue;
        }
        skipped.push(SkippedTag {
            id: *id,
            reason: skipped_reason(*id, &child_map, referenced_tag_ids, &deleted_ids),
        });
    }

    let remaining_orphan_count = tags
        .iter()
        .filter(|tag| !deleted_ids.contains(&tag.id))
        .filter(|tag| tag_is_orphan_leaf(tag.id, &child_map, referenced_tag_ids, &deleted_ids))
        .count();

    OrphanTagCleanupPlan {
        candidate_ids,
        skipped,
        remaining_orphan_count,
    }
}

fn tag_is_orphan_leaf(
    id: i32,
    child_map: &HashMap<i32, Vec<i32>>,
    referenced_tag_ids: &HashSet<i32>,
    deleted_ids: &HashSet<i32>,
) -> bool {
    !referenced_tag_ids.contains(&id)
        && child_map
            .get(&id)
            .map(|children| children.iter().all(|child| deleted_ids.contains(child)))
            .unwrap_or(true)
}

fn skipped_reason(
    id: i32,
    child_map: &HashMap<i32, Vec<i32>>,
    referenced_tag_ids: &HashSet<i32>,
    deleted_ids: &HashSet<i32>,
) -> &'static str {
    if referenced_tag_ids.contains(&id) {
        return "referencedByNotes";
    }
    if child_map
        .get(&id)
        .map(|children| children.iter().any(|child| !deleted_ids.contains(child)))
        .unwrap_or(false)
    {
        return "hasChildren";
    }
    "limitReached"
}

fn tag_map(tags: &[TagNode]) -> HashMap<i32, TagNode> {
    tags.iter().map(|tag| (tag.id, tag.clone())).collect()
}

fn child_map(tags: &[TagNode]) -> HashMap<i32, Vec<i32>> {
    let mut map: HashMap<i32, Vec<i32>> = HashMap::new();
    for tag in tags {
        if tag.parent > 0 {
            map.entry(tag.parent).or_default().push(tag.id);
        }
    }
    map
}

fn depth_map(tags: &[TagNode]) -> HashMap<i32, usize> {
    let by_id = tag_map(tags);
    tags.iter()
        .map(|tag| {
            let mut depth = 0;
            let mut parent = tag.parent;
            while parent > 0 {
                let Some(parent_tag) = by_id.get(&parent) else {
                    break;
                };
                depth += 1;
                parent = parent_tag.parent;
            }
            (tag.id, depth)
        })
        .collect()
}

fn tag_list_json(
    by_id: &HashMap<i32, TagNode>,
    ids: &[i32],
    reason: Option<&'static str>,
) -> Vec<Value> {
    ids.iter()
        .filter_map(|id| by_id.get(id).map(|tag| tag_to_json(by_id, tag, reason)))
        .collect()
}

fn tag_to_json(
    by_id: &HashMap<i32, TagNode>,
    tag: &TagNode,
    reason: Option<&'static str>,
) -> Value {
    let mut value = json!({
        "id": tag.id,
        "name": tag.name,
        "parent": tag.parent,
        "fullName": full_tag_name(by_id, tag.id)
    });
    if let Some(reason) = reason {
        value["reason"] = json!(reason);
    }
    value
}

fn full_tag_name(by_id: &HashMap<i32, TagNode>, id: i32) -> String {
    let mut parts = Vec::new();
    let mut current = id;
    while current > 0 {
        let Some(tag) = by_id.get(&current) else {
            break;
        };
        parts.push(tag.name.as_str());
        current = tag.parent;
    }
    parts.reverse();
    format!("#{}", parts.join("/"))
}

fn tag_ids_from_input(input: &Value) -> Vec<i32> {
    input
        .get("tagIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_i64().map(|value| value as i32))
                .collect()
        })
        .unwrap_or_default()
}

fn unique_ids(ids: &[i32]) -> Vec<i32> {
    let mut seen = HashSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}

fn update_name(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let new_name = input.get("newName").and_then(Value::as_str).unwrap_or("");
        sqlx::query(r#"UPDATE tag SET name=$1, "updatedAt"=blinkora_now() WHERE id=$2 AND "accountId"=$3 AND "workspaceId"=$4"#)
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
            r#"UPDATE tag SET "sortOrder"=$1, "updatedAt"=blinkora_now()
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
            r#"UPDATE tag SET {field}=$1, "updatedAt"=blinkora_now()
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
        let mut tx = ctx.state.pool().begin().await?;
        sqlx::query(
            r#"DELETE FROM "tagsToNote" WHERE "tagId" IN (
                 SELECT id FROM tag WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3
               )"#,
        )
        .bind(id)
        .bind(user.id)
        .bind(ws)
        .execute(&mut *tx)
        .await?;
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
            sqlx::query(r#"UPDATE notes SET "isRecycle"=true, "updatedAt"=blinkora_now() WHERE id IN (SELECT value FROM json_each($1)) AND "accountId"=$2 AND "workspaceId"=$3"#)
                .bind(crate::db::json_array(&note_ids))
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

#[cfg(test)]
mod tests {
    use super::{delete_only, plan_orphan_tag_cleanup, TagNode};
    use crate::handlers::test_support::HandlerTestFixture;
    use serde_json::json;
    use std::collections::HashSet;

    fn tag(id: i32, name: &str, parent: i32) -> TagNode {
        TagNode {
            id,
            name: name.to_string(),
            parent,
        }
    }

    fn refs(ids: &[i32]) -> HashSet<i32> {
        ids.iter().copied().collect()
    }

    #[test]
    fn orphan_cleanup_keeps_referenced_tags() {
        let tags = vec![tag(1, "AI", 0), tag(2, "方法", 0)];
        let plan = plan_orphan_tag_cleanup(&tags, &refs(&[1]), &[], true, 200);

        assert_eq!(plan.candidate_ids, vec![2]);
        assert_eq!(plan.remaining_orphan_count, 0);
    }

    #[test]
    fn orphan_cleanup_deletes_leaf_then_parent() {
        let tags = vec![
            tag(1, "项目", 0),
            tag(2, "网络阅历", 1),
            tag(3, "脏标签", 2),
        ];
        let plan = plan_orphan_tag_cleanup(&tags, &refs(&[]), &[3], false, 200);

        assert_eq!(plan.candidate_ids, vec![3, 2, 1]);
        assert_eq!(plan.remaining_orphan_count, 0);
    }

    #[test]
    fn orphan_cleanup_skips_parent_with_children_when_only_parent_requested() {
        let tags = vec![tag(1, "项目", 0), tag(2, "网络阅历", 1)];
        let plan = plan_orphan_tag_cleanup(&tags, &refs(&[]), &[1], false, 200);

        assert!(plan.candidate_ids.is_empty());
        assert_eq!(plan.skipped[0].id, 1);
        assert_eq!(plan.skipped[0].reason, "hasChildren");
    }

    #[test]
    fn orphan_cleanup_requested_ids_do_not_scan_unrelated_tags() {
        let tags = vec![tag(1, "目标", 0), tag(2, "其他", 0)];
        let plan = plan_orphan_tag_cleanup(&tags, &refs(&[]), &[1], false, 200);

        assert_eq!(plan.candidate_ids, vec![1]);
        assert_eq!(plan.remaining_orphan_count, 1);
    }

    #[test]
    fn orphan_cleanup_all_respects_limit() {
        let tags = vec![tag(1, "一", 0), tag(2, "二", 0), tag(3, "三", 0)];
        let plan = plan_orphan_tag_cleanup(&tags, &refs(&[]), &[], true, 2);

        assert_eq!(plan.candidate_ids, vec![1, 2]);
        assert_eq!(plan.remaining_orphan_count, 1);
    }

    #[tokio::test]
    async fn delete_only_is_atomic_and_cannot_cross_workspace_boundaries() {
        let fixture = HandlerTestFixture::new("tag-delete-isolation").await;
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
        let main_tag: i32 = sqlx::query_scalar(
            r#"INSERT INTO tag (name, "updatedAt", "accountId", "workspaceId")
               VALUES ('main', blinkora_now(), $1, $2) RETURNING id"#,
        )
        .bind(fixture.account_id)
        .bind(fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let other_tag: i32 = sqlx::query_scalar(
            r#"INSERT INTO tag (name, "updatedAt", "accountId", "workspaceId")
               VALUES ('other', blinkora_now(), $1, $2) RETURNING id"#,
        )
        .bind(fixture.account_id)
        .bind(other_workspace)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        for (note, tag) in [(note_id, main_tag), (other_note_id, other_tag)] {
            sqlx::query(r#"INSERT INTO "tagsToNote" ("noteId", "tagId") VALUES ($1, $2)"#)
                .bind(note)
                .bind(tag)
                .execute(&fixture.pool)
                .await
                .unwrap();
        }

        delete_only(fixture.ctx.clone(), json!({ "id": other_tag }))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tag WHERE id=$1")
                .bind(other_tag)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "tagsToNote" WHERE "tagId"=$1"#,)
                .bind(other_tag)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            1
        );

        sqlx::query(&format!(
            r#"CREATE TRIGGER fail_tag_delete BEFORE DELETE ON tag
               WHEN OLD.id={main_tag} BEGIN SELECT RAISE(ABORT, 'forced tag delete failure'); END"#
        ))
        .execute(&fixture.pool)
        .await
        .unwrap();
        delete_only(fixture.ctx.clone(), json!({ "id": main_tag }))
            .await
            .expect_err("tag deletion failure must restore its relation");
        assert_eq!(
            sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "tagsToNote" WHERE "tagId"=$1"#,)
                .bind(main_tag)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            1
        );
        sqlx::query("DROP TRIGGER fail_tag_delete")
            .execute(&fixture.pool)
            .await
            .unwrap();

        delete_only(fixture.ctx.clone(), json!({ "id": main_tag }))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tag WHERE id=$1")
                .bind(main_tag)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "tagsToNote" WHERE "tagId"=$1"#,)
                .bind(main_tag)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0
        );
        crate::db::probe(&fixture.pool).await.unwrap();
        fixture.cleanup().await;
    }
}
