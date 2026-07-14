use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use base64::Engine;
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("fonts.list", list);
    registry.insert("fonts.getFontData", get_font_data);
    registry.insert("fonts.getByName", get_by_name);
    registry.insert("fonts.create", create);
    registry.insert("fonts.update", update);
    registry.insert("fonts.delete", delete);
    registry.insert("fonts.upload", upload);
}

fn list(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let category = input.get("category").and_then(Value::as_str).unwrap_or("");
        let rows = if category.is_empty() {
            sqlx::query(r#"SELECT id, name, "displayName", url, "isLocal", weights, category, "isSystem", "sortOrder", "createdAt", "updatedAt" FROM fonts ORDER BY "sortOrder" ASC, name ASC"#)
                .fetch_all(ctx.state.pool())
                .await?
        } else {
            sqlx::query(r#"SELECT id, name, "displayName", url, "isLocal", weights, category, "isSystem", "sortOrder", "createdAt", "updatedAt" FROM fonts WHERE category=$1 ORDER BY "sortOrder" ASC, name ASC"#)
                .bind(category)
                .fetch_all(ctx.state.pool())
                .await?
        };
        Ok(Value::Array(rows.into_iter().map(|row| json!({
            "id": row.get::<i32, _>("id"),
            "name": row.get::<String, _>("name"),
            "displayName": row.get::<String, _>("displayName"),
            "url": row.get::<Option<String>, _>("url"),
            "isLocal": row.get::<bool, _>("isLocal"),
            "weights": row.get::<Value, _>("weights"),
            "category": row.get::<String, _>("category"),
            "isSystem": row.get::<bool, _>("isSystem"),
            "sortOrder": row.get::<i32, _>("sortOrder"),
            "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
            "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
        })).collect()))
    }
    .boxed()
}

fn get_font_data(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let name = input.get("name").and_then(Value::as_str).unwrap_or("");
        let row = sqlx::query(r#"SELECT name, "fileData" FROM fonts WHERE name=$1"#)
            .bind(name)
            .fetch_optional(ctx.state.pool())
            .await?;
        let Some(row) = row else {
            return Ok(json!({ "name": name, "fileData": Value::Null }));
        };
        let data: Option<Vec<u8>> = row.get("fileData");
        Ok(json!({
            "name": row.get::<String, _>("name"),
            "fileData": data.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        }))
    }
    .boxed()
}

fn get_by_name(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let name = input.get("name").and_then(Value::as_str).unwrap_or("");
        let row = sqlx::query(r#"SELECT id, name, "displayName", url, "fileData", "isLocal", weights, category, "isSystem", "sortOrder", "createdAt", "updatedAt" FROM fonts WHERE name=$1"#)
            .bind(name)
            .fetch_optional(ctx.state.pool())
            .await?;
        Ok(row.map(font_json).unwrap_or(Value::Null))
    }
    .boxed()
}

fn create(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        ensure_superadmin(&ctx)?;
        let name = required_string(&input, "name")?;
        let display_name = required_string(&input, "displayName")?;
        let url = optional_string(&input, "url");
        let is_local = input.get("isLocal").and_then(Value::as_bool).unwrap_or(false);
        let is_system = input.get("isSystem").and_then(Value::as_bool).unwrap_or(false);
        let weights = input.get("weights").cloned().unwrap_or_else(|| json!([400]));
        let category = input.get("category").and_then(Value::as_str).unwrap_or("sans-serif");
        validate_category(category)?;
        let sort_order = input.get("sortOrder").and_then(Value::as_i64).unwrap_or(0) as i32;

        let row = sqlx::query(r#"INSERT INTO fonts (name, "displayName", url, "isLocal", weights, category, "isSystem", "sortOrder", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,blinkora_now()) RETURNING id, name, "displayName", url, "fileData", "isLocal", weights, category, "isSystem", "sortOrder", "createdAt", "updatedAt""#)
            .bind(name)
            .bind(display_name)
            .bind(url)
            .bind(is_local)
            .bind(weights)
            .bind(category)
            .bind(is_system)
            .bind(sort_order)
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(font_json(row))
    }
    .boxed()
}

fn update(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        ensure_superadmin(&ctx)?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        if id <= 0 {
            bail!("id is required");
        }
        let data = input.get("data").unwrap_or(&Value::Null);
        let current = sqlx::query(r#"SELECT name, "displayName", url, "isLocal", weights, category, "isSystem", "sortOrder" FROM fonts WHERE id=$1"#)
            .bind(id)
            .fetch_optional(ctx.state.pool())
            .await?
            .ok_or_else(|| anyhow!("font not found"))?;

        let name = optional_string(data, "name").unwrap_or_else(|| current.get::<String, _>("name"));
        let display_name = optional_string(data, "displayName").unwrap_or_else(|| current.get::<String, _>("displayName"));
        let url = if data.get("url").is_some() { optional_string(data, "url") } else { current.get::<Option<String>, _>("url") };
        let is_local = data.get("isLocal").and_then(Value::as_bool).unwrap_or_else(|| current.get::<bool, _>("isLocal"));
        let weights = data.get("weights").cloned().unwrap_or_else(|| current.get::<Value, _>("weights"));
        let category = optional_string(data, "category").unwrap_or_else(|| current.get::<String, _>("category"));
        validate_category(&category)?;
        let is_system = data.get("isSystem").and_then(Value::as_bool).unwrap_or_else(|| current.get::<bool, _>("isSystem"));
        let sort_order = data.get("sortOrder").and_then(Value::as_i64).map(|value| value as i32).unwrap_or_else(|| current.get::<i32, _>("sortOrder"));

        let row = sqlx::query(r#"UPDATE fonts SET name=$1, "displayName"=$2, url=$3, "isLocal"=$4, weights=$5, category=$6, "isSystem"=$7, "sortOrder"=$8, "updatedAt"=blinkora_now() WHERE id=$9 RETURNING id, name, "displayName", url, "fileData", "isLocal", weights, category, "isSystem", "sortOrder", "createdAt", "updatedAt""#)
            .bind(name)
            .bind(display_name)
            .bind(url)
            .bind(is_local)
            .bind(weights)
            .bind(category)
            .bind(is_system)
            .bind(sort_order)
            .bind(id)
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(font_json(row))
    }
    .boxed()
}

fn delete(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        ensure_superadmin(&ctx)?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        if id <= 0 {
            bail!("id is required");
        }
        sqlx::query("DELETE FROM fonts WHERE id=$1")
            .bind(id)
            .execute(ctx.state.pool())
            .await?;
        Ok(json!({ "success": true }))
    }
    .boxed()
}

fn upload(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        ensure_superadmin(&ctx)?;
        let name = required_string(&input, "name")?;
        let display_name = required_string(&input, "displayName")?;
        let file_data = required_string(&input, "fileData")?;
        let category = input.get("category").and_then(Value::as_str).unwrap_or("sans-serif");
        validate_category(category)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(file_data.as_bytes())
            .map_err(|_| anyhow!("invalid font file data"))?;
        if bytes.is_empty() {
            bail!("Font file is empty");
        }
        const MAX_FONT_SIZE: usize = 10 * 1024 * 1024;
        if bytes.len() > MAX_FONT_SIZE {
            bail!("Font file too large. Maximum size is 10MB");
        }
        let sort_order: i32 = sqlx::query_scalar(r#"SELECT COALESCE(MAX("sortOrder"), 0) + 1 FROM fonts"#)
            .fetch_one(ctx.state.pool())
            .await?;
        let row = sqlx::query(r#"INSERT INTO fonts (name, "displayName", url, "fileData", "isLocal", weights, category, "isSystem", "sortOrder", "updatedAt") VALUES ($1,$2,NULL,$3,true,$4,$5,false,$6,blinkora_now()) RETURNING id, name, "displayName", url, "isLocal", weights, category, "isSystem", "sortOrder", "createdAt", "updatedAt""#)
            .bind(name)
            .bind(display_name)
            .bind(bytes)
            .bind(json!([100, 200, 300, 400, 500, 600, 700, 800, 900]))
            .bind(category)
            .bind(sort_order)
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(font_metadata_json(row))
    }
    .boxed()
}

fn ensure_superadmin(ctx: &ProcedureContext) -> anyhow::Result<()> {
    let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
    if user.role != "superadmin" {
        bail!("Unauthorized: Only superadmin can manage fonts");
    }
    Ok(())
}

fn required_string(input: &Value, key: &str) -> anyhow::Result<String> {
    let value = input.get(key).and_then(Value::as_str).unwrap_or("").trim();
    if value.is_empty() {
        bail!("{key} is required");
    }
    Ok(value.to_string())
}

fn optional_string(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn validate_category(category: &str) -> anyhow::Result<()> {
    match category {
        "serif" | "sans-serif" | "monospace" | "display" | "handwriting" => Ok(()),
        _ => bail!("invalid font category"),
    }
}

fn font_metadata_json(row: sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "displayName": row.get::<String, _>("displayName"),
        "url": row.get::<Option<String>, _>("url"),
        "isLocal": row.get::<bool, _>("isLocal"),
        "weights": row.get::<Value, _>("weights"),
        "category": row.get::<String, _>("category"),
        "isSystem": row.get::<bool, _>("isSystem"),
        "sortOrder": row.get::<i32, _>("sortOrder"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
    })
}

fn font_json(row: sqlx::sqlite::SqliteRow) -> Value {
    let data: Option<Vec<u8>> = row.get("fileData");
    let mut value = font_metadata_json(row);
    value["fileData"] = data
        .map(|bytes| json!(base64::engine::general_purpose::STANDARD.encode(bytes)))
        .unwrap_or(Value::Null);
    value
}
