use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use crate::util::{config_json, unwrap_config_value};
use anyhow::anyhow;
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("config.list", list);
    registry.insert("config.update", update);
    registry.insert("config.saveAndValidateS3", save_and_validate_s3);
}

fn list(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user_id = ctx.user.as_ref().map(|user| user.id).unwrap_or_default();
        let workspace_id = resolve_workspace_id(&ctx, user_id).await.unwrap_or_default();
        let rows = if user_id > 0 {
            sqlx::query(
                r#"SELECT key, config, "userId" FROM config
                   WHERE "userId" IS NULL OR ("userId"=$1 AND "workspaceId"=$2)
                   ORDER BY CASE WHEN "userId" IS NULL THEN 0 ELSE 1 END"#,
            )
            .bind(user_id)
            .bind(workspace_id)
            .fetch_all(ctx.state.pool())
            .await?
        } else {
            sqlx::query(r#"SELECT key, config, "userId" FROM config WHERE "userId" IS NULL"#)
                .fetch_all(ctx.state.pool())
                .await?
        };
        let mut out = serde_json::Map::new();
        for row in rows {
            let key: String = row.get("key");
            let scoped_user_id: Option<i32> = row.get("userId");
            if scoped_user_id.is_some() && is_global_config_key(&key) {
                continue;
            }
            let value: Option<Value> = row.get("config");
            out.insert(key, unwrap_config_value(value));
        }
        Ok(Value::Object(out))
    }
    .boxed()
}

fn update(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let key = input.get("key").and_then(Value::as_str).unwrap_or("");
        if key.is_empty() {
            return Err(anyhow!("key is required"));
        }
        let value = input.get("value").cloned().or_else(|| input.get("config").cloned()).unwrap_or(Value::Null);
        if is_global_config_key(key) {
            if user.role != "superadmin" {
                return Err(anyhow!("You are not allowed to update global config"));
            }
            upsert_global_config(&ctx, key, config_json(value)).await?;
        } else {
            let workspace_id = resolve_workspace_id_required(&ctx, user.id).await?;
            upsert_config(&ctx, key, config_json(value), Some(user.id), Some(workspace_id)).await?;
        }
        Ok(json!(true))
    }
    .boxed()
}

fn save_and_validate_s3(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        if user.role != "superadmin" {
            return Err(anyhow!("You are not allowed to update global config"));
        }

        let normalized_custom_path = match crate::s3::normalize_custom_path(input.get("s3CustomPath").and_then(Value::as_str).unwrap_or("")) {
            Ok(value) => value,
            Err(err) => {
                upsert_global_config(&ctx, "objectStorage", config_json(json!("local"))).await?;
                return Ok(json!({
                    "success": false,
                    "ok": false,
                    "objectStorage": "local",
                    "normalizedCustomPath": "",
                    "message": err.to_string()
                }));
            }
        };
        let config = crate::s3::S3Config {
            endpoint: input.get("s3Endpoint").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            region: input.get("s3Region").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            bucket: input.get("s3Bucket").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            access_key_id: input.get("s3AccessKeyId").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            access_key_secret: input
                .get("s3AccessKeySecret")
                .or_else(|| input.get("s3SecretAccessKey"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            custom_path: normalized_custom_path.clone(),
            force_path_style: input.get("s3ForcePathStyle").and_then(Value::as_bool).unwrap_or(false),
        };

        let validation = crate::s3::validate_config(&config).await;
        match validation {
            Ok((validation_key, force_path_style)) => {
                save_s3_values(&ctx, &input, "s3", &normalized_custom_path, Some(force_path_style)).await?;
                Ok(json!({
                    "success": true,
                    "ok": true,
                    "objectStorage": "s3",
                    "normalizedCustomPath": normalized_custom_path,
                    "validationKey": validation_key,
                    "forcePathStyle": force_path_style
                }))
            }
            Err(err) => {
                save_s3_values(&ctx, &input, "local", &normalized_custom_path, None).await?;
                Ok(json!({
                    "success": false,
                    "ok": false,
                    "objectStorage": "local",
                    "normalizedCustomPath": normalized_custom_path,
                    "message": err.to_string()
                }))
            }
        }
    }
    .boxed()
}

async fn resolve_workspace_id(ctx: &ProcedureContext, user_id: i32) -> anyhow::Result<i32> {
    if user_id <= 0 {
        return Ok(0);
    }
    resolve_workspace_id_required(ctx, user_id).await
}

async fn resolve_workspace_id_required(ctx: &ProcedureContext, user_id: i32) -> anyhow::Result<i32> {
    if let Some(workspace_id) = ctx.user.as_ref().and_then(|user| user.workspace_id) {
        return Ok(workspace_id);
    }
    let id: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM workspaces WHERE "accountId"=$1 AND "isDefault"=true"#)
        .bind(user_id)
        .fetch_optional(ctx.state.pool())
        .await?;
    if let Some(id) = id {
        return Ok(id);
    }
    let fallback: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM workspaces WHERE "accountId"=$1 ORDER BY id ASC LIMIT 1"#)
        .bind(user_id)
        .fetch_optional(ctx.state.pool())
        .await?;
    fallback.ok_or_else(|| anyhow!("workspace not found"))
}

async fn upsert_config(
    ctx: &ProcedureContext,
    key: &str,
    value: Value,
    user_id: Option<i32>,
    workspace_id: Option<i32>,
) -> anyhow::Result<()> {
    if let (Some(user_id), Some(workspace_id)) = (user_id, workspace_id) {
        let existing: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM config WHERE key=$1 AND "userId"=$2 AND "workspaceId"=$3"#)
            .bind(key)
            .bind(user_id)
            .bind(workspace_id)
            .fetch_optional(ctx.state.pool())
            .await?;
        if let Some(id) = existing {
            sqlx::query("UPDATE config SET config=$1 WHERE id=$2")
                .bind(value)
                .bind(id)
                .execute(ctx.state.pool())
                .await?;
        } else {
            sqlx::query(r#"INSERT INTO config (key, config, "userId", "workspaceId") VALUES ($1,$2,$3,$4)"#)
                .bind(key)
                .bind(value)
                .bind(user_id)
                .bind(workspace_id)
                .execute(ctx.state.pool())
                .await?;
        }
    } else {
        let existing: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM config WHERE key=$1 AND "userId" IS NULL"#)
            .bind(key)
            .fetch_optional(ctx.state.pool())
            .await?;
        if let Some(id) = existing {
            sqlx::query("UPDATE config SET config=$1 WHERE id=$2")
                .bind(value)
                .bind(id)
                .execute(ctx.state.pool())
                .await?;
        } else {
            sqlx::query(r#"INSERT INTO config (key, config) VALUES ($1,$2)"#)
                .bind(key)
                .bind(value)
                .execute(ctx.state.pool())
                .await?;
        }
    }
    Ok(())
}

async fn upsert_global_config(ctx: &ProcedureContext, key: &str, value: Value) -> anyhow::Result<()> {
    upsert_config(ctx, key, value, None, None).await?;
    sqlx::query(r#"DELETE FROM config WHERE key=$1 AND "userId" IS NOT NULL"#)
        .bind(key)
        .execute(ctx.state.pool())
        .await?;
    Ok(())
}

fn is_global_config_key(key: &str) -> bool {
    matches!(
        key,
        "objectStorage"
            | "s3Endpoint"
            | "s3Region"
            | "s3Bucket"
            | "s3AccessKeyId"
            | "s3AccessKeySecret"
            | "s3SecretAccessKey"
            | "s3CustomPath"
            | "s3ForcePathStyle"
            | "localCustomPath"
    )
}

async fn save_s3_values(
    ctx: &ProcedureContext,
    input: &Value,
    object_storage: &str,
    normalized_custom_path: &str,
    force_path_style: Option<bool>,
) -> anyhow::Result<()> {
    let values = [
        ("objectStorage", json!(object_storage)),
        ("s3Endpoint", json!(input.get("s3Endpoint").and_then(Value::as_str).unwrap_or("").trim())),
        ("s3Region", json!(input.get("s3Region").and_then(Value::as_str).unwrap_or("").trim())),
        ("s3Bucket", json!(input.get("s3Bucket").and_then(Value::as_str).unwrap_or("").trim())),
        ("s3AccessKeyId", json!(input.get("s3AccessKeyId").and_then(Value::as_str).unwrap_or("").trim())),
        (
            "s3AccessKeySecret",
            json!(
                input
                    .get("s3AccessKeySecret")
                    .or_else(|| input.get("s3SecretAccessKey"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
            ),
        ),
        ("s3CustomPath", json!(normalized_custom_path)),
    ];
    for (key, value) in values {
        upsert_global_config(ctx, key, config_json(value)).await?;
    }
    if let Some(force_path_style) = force_path_style {
        upsert_global_config(ctx, "s3ForcePathStyle", config_json(json!(force_path_style))).await?;
    }
    Ok(())
}
