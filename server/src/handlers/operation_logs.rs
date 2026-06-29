use super::common::workspace_id;
use crate::auth::CurrentUser;
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use crate::util::unwrap_config_value;
use anyhow::anyhow;
use futures::FutureExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, QueryBuilder, Row, Transaction};
use std::collections::{HashMap, HashSet};

const DEFAULT_LOGGED_NOTE_TYPES: &[i32] = &[1];

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("operationLogs.list", list);
}

#[derive(Debug, Clone)]
pub struct OperationLogDraft {
    pub action: String,
    pub note_id: i32,
    pub note_type: i32,
    pub previous_note_type: Option<i32>,
    pub note_title: String,
    pub changed_fields: Vec<String>,
    pub summary: String,
    pub details: Value,
}

struct OperationLogFilters<'a> {
    account_id: i32,
    workspace_id: i32,
    after_id: Option<i32>,
    before_id: Option<i32>,
    start_date: Option<&'a str>,
    end_date: Option<&'a str>,
    actor_type: Option<&'a str>,
    actions: Vec<String>,
    note_types: Vec<i32>,
    note_id: Option<i32>,
    changed_field: Option<&'a str>,
}

pub async fn insert_note_log_if_enabled_tx(
    ctx: &ProcedureContext,
    tx: &mut Transaction<'_, Postgres>,
    user: &CurrentUser,
    draft: OperationLogDraft,
) -> anyhow::Result<()> {
    if draft.changed_fields.is_empty() {
        return Ok(());
    }

    let ws = workspace_id(ctx).await?;
    let enabled_types = enabled_note_types_tx(tx, user.id, ws).await?;
    let should_log_current = enabled_types.contains(&draft.note_type);
    let should_log_previous = draft
        .previous_note_type
        .is_some_and(|note_type| enabled_types.contains(&note_type));
    if !should_log_current && !should_log_previous {
        return Ok(());
    }

    let actor_type = if user.is_workspace_agent() {
        "agent"
    } else {
        "user"
    };
    let actor_label = actor_label(user);
    let changed_fields = Value::Array(
        unique_strings(&draft.changed_fields)
            .into_iter()
            .map(Value::String)
            .collect(),
    );

    sqlx::query(
        r#"INSERT INTO "operationLog"
           ("accountId", "workspaceId", "actorType", "actorAccountId", "actorAgentTokenId",
            "actorLabel", action, "noteId", "noteType", "noteTitle", "changedFields", summary, details)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)"#,
    )
    .bind(user.id)
    .bind(ws)
    .bind(actor_type)
    .bind(user.id)
    .bind(user.agent_token_id)
    .bind(actor_label)
    .bind(draft.action)
    .bind(draft.note_id)
    .bind(draft.note_type)
    .bind(draft.note_title)
    .bind(changed_fields)
    .bind(draft.summary)
    .bind(draft.details)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn note_title(content: &str, note_id: i32) -> String {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let title = if line.starts_with('#') {
            line.trim_start_matches('#').trim()
        } else {
            line
        };
        if !title.is_empty() {
            return truncate_chars(title, 80);
        }
    }
    format!("Untitled note #{note_id}")
}

pub fn content_change_detail(
    before: Option<&str>,
    after: &str,
    previous_version: Option<i32>,
) -> Value {
    json!({
        "beforeHash": before.map(content_hash),
        "afterHash": content_hash(after),
        "beforeLength": before.map(|value| value.chars().count()),
        "afterLength": after.chars().count(),
        "previousVersion": previous_version
    })
}

pub fn unique_strings(items: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if seen.insert(item.clone()) {
            out.push(item.clone());
        }
    }
    out
}

fn list(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let page = input
            .get("page")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1);
        let size = input
            .get("size")
            .and_then(Value::as_i64)
            .unwrap_or(30)
            .clamp(1, 200);
        let offset = (page - 1) * size;
        let filters = OperationLogFilters {
            account_id: user.id,
            workspace_id: ws,
            after_id: input
                .get("afterId")
                .and_then(Value::as_i64)
                .map(|value| value as i32),
            before_id: input
                .get("beforeId")
                .and_then(Value::as_i64)
                .map(|value| value as i32),
            start_date: input
                .get("startDate")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty()),
            end_date: input
                .get("endDate")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty()),
            actor_type: input
                .get("actorType")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && *value != "all"),
            actions: string_values(input.get("actions").or_else(|| input.get("action"))),
            note_types: i32_values(input.get("noteTypes").or_else(|| input.get("noteType"))),
            note_id: input
                .get("noteId")
                .and_then(Value::as_i64)
                .map(|value| value as i32),
            changed_field: input
                .get("changedField")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && *value != "all"),
        };
        let order_dir = if input.get("orderBy").and_then(Value::as_str) == Some("asc") {
            "ASC"
        } else {
            "DESC"
        };

        let mut count_query =
            QueryBuilder::<Postgres>::new(r#"SELECT COUNT(*) FROM "operationLog" l WHERE "#);
        push_filters(&mut count_query, &filters);
        let total = count_query
            .build_query_scalar::<i64>()
            .fetch_one(ctx.state.pool())
            .await?;

        let mut query = QueryBuilder::<Postgres>::new(
            r#"SELECT id, "accountId", "workspaceId", "actorType", "actorAccountId",
                      "actorAgentTokenId", "actorLabel", action, "noteId", "noteType",
                      "noteTitle", "changedFields", summary, details, "createdAt"
               FROM "operationLog" l WHERE "#,
        );
        push_filters(&mut query, &filters);
        query.push(r#" ORDER BY l.id "#).push(order_dir);
        query
            .push(" LIMIT ")
            .push_bind(size)
            .push(" OFFSET ")
            .push_bind(offset);
        let rows = query.build().fetch_all(ctx.state.pool()).await?;
        let items = rows.into_iter().map(log_json).collect::<Vec<_>>();
        let next_cursor = items
            .last()
            .and_then(|item| item.get("id").and_then(Value::as_i64));

        Ok(json!({
            "items": items,
            "page": page,
            "size": size,
            "total": total,
            "nextCursor": next_cursor
        }))
    }
    .boxed()
}

fn push_filters<'a>(query: &mut QueryBuilder<'a, Postgres>, filters: &'a OperationLogFilters<'a>) {
    query
        .push(r#"l."accountId"="#)
        .push_bind(filters.account_id)
        .push(r#" AND l."workspaceId"="#)
        .push_bind(filters.workspace_id);
    if let Some(after_id) = filters.after_id {
        query.push(" AND l.id>").push_bind(after_id);
    }
    if let Some(before_id) = filters.before_id {
        query.push(" AND l.id<").push_bind(before_id);
    }
    if let Some(start_date) = filters.start_date {
        query.push(r#" AND l."createdAt" >= "#);
        query.push_bind(start_date.to_string());
        query.push("::timestamptz");
    }
    if let Some(end_date) = filters.end_date {
        query.push(r#" AND l."createdAt" <= "#);
        query.push_bind(end_date.to_string());
        query.push("::timestamptz");
    }
    if let Some(actor_type) = filters.actor_type {
        query.push(r#" AND l."actorType"="#).push_bind(actor_type);
    }
    if !filters.actions.is_empty() {
        query
            .push(" AND l.action=ANY(")
            .push_bind(&filters.actions)
            .push(")");
    }
    if !filters.note_types.is_empty() {
        query
            .push(r#" AND l."noteType"=ANY("#)
            .push_bind(&filters.note_types)
            .push(")");
    }
    if let Some(note_id) = filters.note_id {
        query.push(r#" AND l."noteId"="#).push_bind(note_id);
    }
    if let Some(changed_field) = filters.changed_field {
        query
            .push(r#" AND COALESCE(l."changedFields"::jsonb, '[]'::jsonb) ? "#)
            .push_bind(changed_field);
    }
}

fn log_json(row: sqlx::postgres::PgRow) -> Value {
    let changed_fields = row
        .get::<Option<Value>, _>("changedFields")
        .unwrap_or_else(|| json!([]));
    json!({
        "id": row.get::<i32, _>("id"),
        "accountId": row.get::<Option<i32>, _>("accountId"),
        "workspaceId": row.get::<Option<i32>, _>("workspaceId"),
        "actor": {
            "type": row.get::<String, _>("actorType"),
            "accountId": row.get::<Option<i32>, _>("actorAccountId"),
            "agentTokenId": row.get::<Option<i32>, _>("actorAgentTokenId"),
            "label": row.get::<String, _>("actorLabel")
        },
        "action": row.get::<String, _>("action"),
        "target": {
            "type": "note",
            "noteId": row.get::<Option<i32>, _>("noteId"),
            "noteType": row.get::<Option<i32>, _>("noteType"),
            "title": row.get::<String, _>("noteTitle")
        },
        "changedFields": changed_fields,
        "summary": row.get::<String, _>("summary"),
        "details": row.get::<Option<Value>, _>("details").unwrap_or_else(|| json!({})),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt")
    })
}

async fn enabled_note_types_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<HashSet<i32>> {
    let value: Option<Value> = sqlx::query_scalar(
        r#"SELECT config FROM config
           WHERE key='operationLogNoteTypes' AND "userId"=$1 AND "workspaceId"=$2
           LIMIT 1"#,
    )
    .bind(account_id)
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await?;
    let unwrapped = unwrap_config_value(value);
    let items = match unwrapped {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|value| value.as_i64().map(|number| number as i32))
            .collect::<Vec<_>>(),
        _ => DEFAULT_LOGGED_NOTE_TYPES.to_vec(),
    };
    Ok(items.into_iter().collect())
}

fn actor_label(user: &CurrentUser) -> String {
    let base = if user.nickname.trim().is_empty() {
        user.name.trim()
    } else {
        user.nickname.trim()
    };
    if user.is_workspace_agent() {
        match user.agent_token_id {
            Some(id) if !base.is_empty() => format!("{base} / Agent #{id}"),
            Some(id) => format!("Agent #{id}"),
            None => "Workspace Agent".to_string(),
        }
    } else if base.is_empty() {
        format!("User #{}", user.id)
    } else {
        base.to_string()
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in value.chars().enumerate() {
        if idx >= max_chars {
            out.push_str("...");
            break;
        }
        out.push(ch);
    }
    out
}

fn string_values(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) if !value.is_empty() && value != "all" => vec![value.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|value| !value.is_empty() && *value != "all")
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn i32_values(value: Option<&Value>) -> Vec<i32> {
    match value {
        Some(Value::Number(value)) => value
            .as_i64()
            .map(|value| vec![value as i32])
            .unwrap_or_default(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_i64)
            .map(|value| value as i32)
            .collect(),
        _ => Vec::new(),
    }
}
