use crate::auth::{generate_agent_token, hash_agent_token, AgentPermissions};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use chrono::{DateTime, Utc};
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("agentTokens.list", list);
    registry.insert("agentTokens.create", create);
    registry.insert("agentTokens.revoke", revoke);
}

fn list(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        if user.is_workspace_agent() {
            bail!("Agent token cannot manage agent tokens");
        }

        let workspace_id = input.get("workspaceId").and_then(Value::as_i64).map(|value| value as i32);
        let rows = if let Some(workspace_id) = workspace_id {
            sqlx::query(
                r#"SELECT t.id, t.name, t."token", t."accountId", t."workspaceId", w.name AS "workspaceName", t.permissions,
                          t."expiresAt", t."revokedAt", t."lastUsedAt", t."createdAt", t."updatedAt"
                   FROM "agentAccessTokens" t
                   JOIN workspaces w ON w.id=t."workspaceId"
                   WHERE t."accountId"=$1 AND t."workspaceId"=$2
                   ORDER BY t."createdAt" DESC"#,
            )
            .bind(user.id)
            .bind(workspace_id)
            .fetch_all(ctx.state.pool())
            .await?
        } else {
            sqlx::query(
                r#"SELECT t.id, t.name, t."token", t."accountId", t."workspaceId", w.name AS "workspaceName", t.permissions,
                          t."expiresAt", t."revokedAt", t."lastUsedAt", t."createdAt", t."updatedAt"
                   FROM "agentAccessTokens" t
                   JOIN workspaces w ON w.id=t."workspaceId"
                   WHERE t."accountId"=$1
                   ORDER BY t."createdAt" DESC"#,
            )
            .bind(user.id)
            .fetch_all(ctx.state.pool())
            .await?
        };

        Ok(Value::Array(rows.into_iter().map(|row| token_json(row, None)).collect()))
    }
    .boxed()
}

fn create(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        if user.is_workspace_agent() {
            bail!("Agent token cannot manage agent tokens");
        }

        let workspace_id = input.get("workspaceId").and_then(Value::as_i64).unwrap_or_default() as i32;
        if workspace_id <= 0 {
            bail!("workspaceId is required");
        }
        let workspace_exists: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM workspaces WHERE id=$1 AND "accountId"=$2"#)
            .bind(workspace_id)
            .bind(user.id)
            .fetch_optional(ctx.state.pool())
            .await?;
        if workspace_exists.is_none() {
            bail!("workspace not found");
        }

        let name = input.get("name").and_then(Value::as_str).unwrap_or("Agent Workspace Token").trim();
        let name = if name.is_empty() { "Agent Workspace Token" } else { name };
        let expires_at = parse_expires_at(input.get("expiresAt"))?;
        let token = generate_agent_token();
        let token_hash = hash_agent_token(&token);
        let permissions = AgentPermissions::default_json();

        let row = sqlx::query(
            r#"INSERT INTO "agentAccessTokens" (name, "tokenHash", token, "accountId", "workspaceId", permissions, "expiresAt", "updatedAt")
               VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
               RETURNING id, name, token, "accountId", "workspaceId",
                         (SELECT name FROM workspaces WHERE id=$5) AS "workspaceName",
                         permissions, "expiresAt", "revokedAt", "lastUsedAt", "createdAt", "updatedAt""#,
        )
        .bind(name)
        .bind(token_hash)
        .bind(token.clone())
        .bind(user.id)
        .bind(workspace_id)
        .bind(permissions)
        .bind(expires_at)
        .fetch_one(ctx.state.pool())
        .await?;

        Ok(token_json(row, Some(token)))
    }
    .boxed()
}

fn revoke(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        if user.is_workspace_agent() {
            bail!("Agent token cannot manage agent tokens");
        }

        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        if id <= 0 {
            bail!("id is required");
        }

        let row = sqlx::query(
            r#"UPDATE "agentAccessTokens"
               SET "revokedAt"=NOW(), "updatedAt"=NOW()
               WHERE id=$1 AND "accountId"=$2
               RETURNING id, name, "accountId", "workspaceId",
                         token,
                         (SELECT name FROM workspaces WHERE id="agentAccessTokens"."workspaceId") AS "workspaceName",
                         permissions, "expiresAt", "revokedAt", "lastUsedAt", "createdAt", "updatedAt""#,
        )
        .bind(id)
        .bind(user.id)
        .fetch_optional(ctx.state.pool())
        .await?;

        let Some(row) = row else {
            bail!("token not found");
        };
        Ok(token_json(row, None))
    }
    .boxed()
}

fn parse_expires_at(value: Option<&Value>) -> anyhow::Result<Option<DateTime<Utc>>> {
    let Some(value) = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    Ok(Some(
        DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc),
    ))
}

fn token_json(row: sqlx::postgres::PgRow, token: Option<String>) -> Value {
    let mut value = json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "accountId": row.get::<i32, _>("accountId"),
        "workspaceId": row.get::<i32, _>("workspaceId"),
        "workspaceName": row.get::<String, _>("workspaceName"),
        "permissions": row.get::<Value, _>("permissions"),
        "expiresAt": row.get::<Option<DateTime<Utc>>, _>("expiresAt"),
        "revokedAt": row.get::<Option<DateTime<Utc>>, _>("revokedAt"),
        "lastUsedAt": row.get::<Option<DateTime<Utc>>, _>("lastUsedAt"),
        "createdAt": row.get::<DateTime<Utc>, _>("createdAt"),
        "updatedAt": row.get::<DateTime<Utc>, _>("updatedAt")
    });
    let stored_token = row.try_get::<Option<String>, _>("token").ok().flatten();
    if let Some(token) = token.or(stored_token) {
        value["token"] = json!(token);
    }
    value
}
