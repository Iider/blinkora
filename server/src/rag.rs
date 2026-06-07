use anyhow::{anyhow, Context};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

pub async fn ensure_vector_table(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS "_blinkora_rust_vectors" (
            id SERIAL PRIMARY KEY,
            "noteId" INTEGER NOT NULL,
            "accountId" INTEGER NOT NULL,
            "workspaceId" INTEGER NOT NULL,
            kind VARCHAR(32) NOT NULL DEFAULT 'note',
            text TEXT NOT NULL,
            vector JSONB NOT NULL,
            metadata JSONB,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"#,
    )
    .execute(pool)
    .await?;
    sqlx::query(r#"CREATE INDEX IF NOT EXISTS "_blinkora_rust_vectors_note_idx" ON "_blinkora_rust_vectors" ("noteId")"#)
        .execute(pool)
        .await?;
    sqlx::query(r#"CREATE INDEX IF NOT EXISTS "_blinkora_rust_vectors_workspace_idx" ON "_blinkora_rust_vectors" ("accountId", "workspaceId")"#)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn rebuild_workspace_index(pool: &PgPool, account_id: i32, workspace_id: i32, incremental: bool, processed_note_ids: &[i32]) -> anyhow::Result<Vec<IndexedNoteResult>> {
    ensure_vector_table(pool).await?;
    let embedding_config = load_embedding_config(pool, account_id, workspace_id).await?;
    if !incremental {
        sqlx::query(r#"DELETE FROM "_blinkora_rust_vectors" WHERE "accountId"=$1 AND "workspaceId"=$2"#)
            .bind(account_id)
            .bind(workspace_id)
            .execute(pool)
            .await?;
    }

    let rows = if incremental && !processed_note_ids.is_empty() {
        sqlx::query(
            r#"SELECT id, type, content, "isArchived", "isRecycle", "createdAt", "updatedAt" FROM notes
               WHERE "accountId"=$1 AND "workspaceId"=$2 AND "isRecycle"=false AND NOT (id=ANY($3))
               ORDER BY id ASC"#,
        )
        .bind(account_id)
        .bind(workspace_id)
        .bind(processed_note_ids)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            r#"SELECT id, type, content, "isArchived", "isRecycle", "createdAt", "updatedAt" FROM notes
               WHERE "accountId"=$1 AND "workspaceId"=$2 AND "isRecycle"=false
               ORDER BY id ASC"#,
        )
        .bind(account_id)
        .bind(workspace_id)
        .fetch_all(pool)
        .await?
    };

    let mut results = Vec::new();
    for row in rows {
        let note_id: i32 = row.get("id");
        let note_type: i32 = row.get("type");
        let content: String = row.get("content");
        let is_archived: bool = row.get("isArchived");
        let is_recycle: bool = row.get("isRecycle");
        let updated_at: chrono::DateTime<chrono::Utc> = row.get("updatedAt");
        let attachment_rows = sqlx::query(r#"SELECT path FROM attachments WHERE "noteId"=$1 ORDER BY id ASC"#)
            .bind(note_id)
            .fetch_all(pool)
            .await?;
        let attachment_paths = attachment_rows
            .iter()
            .filter_map(|row| row.try_get::<String, _>("path").ok())
            .collect::<Vec<_>>();
        let tag_rows = sqlx::query(
            r#"SELECT t.id, t.name
               FROM "tagsToNote" ttn
               JOIN tag t ON t.id=ttn."tagId"
               WHERE ttn."noteId"=$1
               ORDER BY t.parent ASC, t."sortOrder" ASC, t.id ASC"#,
        )
        .bind(note_id)
        .fetch_all(pool)
        .await?;
        let tag_ids = tag_rows.iter().filter_map(|row| row.try_get::<i32, _>("id").ok()).collect::<Vec<_>>();
        let tag_names = tag_rows.iter().filter_map(|row| row.try_get::<String, _>("name").ok()).collect::<Vec<_>>();
        let index_text = build_index_text(&content, &attachment_paths);
        let vector = match embedding_config.as_ref() {
            Some(config) => embed_texts(config, std::slice::from_ref(&index_text))
                .await
                .ok()
                .and_then(|mut vectors| vectors.pop())
                .map(StoredVector::Dense)
                .unwrap_or_else(|| StoredVector::Sparse(text_vector(&index_text))),
            None => StoredVector::Sparse(text_vector(&index_text)),
        };
        let metadata = json!({
            "text": preview(&content),
            "id": note_id,
            "noteId": note_id,
            "accountId": account_id,
            "workspaceId": workspace_id,
            "type": note_type,
            "tagIds": tag_ids,
            "tags": tag_names,
            "isArchived": is_archived,
            "isRecycle": is_recycle,
            "updatedAt": updated_at.to_rfc3339(),
            "kind": vector.kind(),
            "attachmentCount": attachment_paths.len(),
            "provider": embedding_config.as_ref().map(|config| config.provider.as_str())
        });
        sqlx::query(r#"DELETE FROM "_blinkora_rust_vectors" WHERE "noteId"=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(note_id)
            .bind(account_id)
            .bind(workspace_id)
            .execute(pool)
            .await?;
        sqlx::query(
            r#"INSERT INTO "_blinkora_rust_vectors" ("noteId", "accountId", "workspaceId", kind, text, vector, metadata, "updatedAt")
               VALUES ($1,$2,$3,'note',$4,$5,$6,NOW())"#,
        )
        .bind(note_id)
        .bind(account_id)
        .bind(workspace_id)
        .bind(index_text)
        .bind(vector_to_json(&vector))
        .bind(metadata)
        .execute(pool)
        .await?;
        results.push(IndexedNoteResult {
            note_id,
            content_preview: preview(&content),
            attachment_count: attachment_paths.len(),
        });
    }
    Ok(results)
}

pub async fn delete_note_vectors(pool: &PgPool, note_ids: &[i32], account_id: i32, workspace_id: i32) -> anyhow::Result<()> {
    if note_ids.is_empty() {
        return Ok(());
    }
    ensure_vector_table(pool).await?;
    sqlx::query(r#"DELETE FROM "_blinkora_rust_vectors" WHERE "noteId"=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3"#)
        .bind(note_ids)
        .bind(account_id)
        .bind(workspace_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn query_note_ids(pool: &PgPool, query: &str, account_id: i32, workspace_id: i32, limit: i64) -> anyhow::Result<Vec<VectorMatch>> {
    ensure_vector_table(pool).await?;
    let embedding_config = load_embedding_config(pool, account_id, workspace_id).await?;
    let dense_query_vector = match embedding_config.as_ref() {
        Some(config) => embed_texts(config, &[query.to_string()]).await.ok().and_then(|mut vectors| vectors.pop()),
        None => None,
    };
    let sparse_query_vector = text_vector(query);
    let has_query_vector = dense_query_vector.as_ref().map(|vector| !vector.is_empty()).unwrap_or(false) || !sparse_query_vector.is_empty();
    if !has_query_vector { return Ok(Vec::new()); }
    let rows = sqlx::query(
        r#"SELECT "noteId", vector FROM "_blinkora_rust_vectors"
           WHERE "accountId"=$1 AND "workspaceId"=$2"#,
    )
    .bind(account_id)
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;
    let mut matches = Vec::new();
    for row in rows {
        let note_id: i32 = row.get("noteId");
        let vector_value: Value = row.get("vector");
        let vector = vector_from_json(&vector_value);
        let score = match (&dense_query_vector, vector) {
            (Some(query_vector), StoredVector::Dense(vector)) => dense_cosine_similarity(query_vector, &vector),
            (_, StoredVector::Sparse(vector)) => sparse_cosine_similarity(&sparse_query_vector, &vector),
            _ => 0.0,
        };
        if score > 0.0 {
            matches.push(VectorMatch { note_id, score });
        }
    }
    matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut seen = HashSet::new();
    matches.retain(|item| seen.insert(item.note_id));
    matches.truncate(limit.max(0) as usize);
    Ok(matches)
}

pub async fn vector_count(pool: &PgPool, account_id: i32, workspace_id: i32) -> anyhow::Result<i64> {
    ensure_vector_table(pool).await?;
    Ok(sqlx::query_scalar(r#"SELECT COUNT(*) FROM "_blinkora_rust_vectors" WHERE "accountId"=$1 AND "workspaceId"=$2"#)
        .bind(account_id)
        .bind(workspace_id)
        .fetch_one(pool)
        .await
        .context("count rust vectors")?)
}

pub struct IndexedNoteResult {
    pub note_id: i32,
    pub content_preview: String,
    pub attachment_count: usize,
}

pub struct VectorMatch {
    pub note_id: i32,
    pub score: f64,
}

#[derive(Clone)]
struct EmbeddingConfig {
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model_key: String,
    api_version: Option<String>,
}

enum StoredVector {
    Dense(Vec<f64>),
    Sparse(HashMap<String, f64>),
}

impl StoredVector {
    fn kind(&self) -> &'static str {
        match self {
            StoredVector::Dense(_) => "rust-external-embedding",
            StoredVector::Sparse(_) => "rust-local-vector",
        }
    }
}

fn build_index_text(content: &str, attachment_paths: &[String]) -> String {
    if attachment_paths.is_empty() {
        content.to_string()
    } else {
        format!("{content}\n{}", attachment_paths.join("\n"))
    }
}

fn text_vector(text: &str) -> HashMap<String, f64> {
    let mut counts: HashMap<String, f64> = HashMap::new();
    for token in tokens(text) {
        *counts.entry(token).or_insert(0.0) += 1.0;
    }
    if counts.is_empty() {
        return HashMap::new();
    }
    let norm = counts.values().map(|count| count * count).sum::<f64>().sqrt();
    if norm <= f64::EPSILON {
        return HashMap::new();
    }
    counts.into_iter().map(|(token, count)| (token, count / norm)).collect()
}

fn sparse_cosine_similarity(left: &HashMap<String, f64>, right: &HashMap<String, f64>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    left.iter()
        .filter_map(|(token, left_weight)| right.get(token).map(|right_weight| left_weight * right_weight))
        .sum::<f64>()
}

fn dense_cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let len = left.len().min(right.len());
    let dot = left.iter().take(len).zip(right.iter().take(len)).map(|(a, b)| a * b).sum::<f64>();
    let left_norm = left.iter().take(len).map(|value| value * value).sum::<f64>().sqrt();
    let right_norm = right.iter().take(len).map(|value| value * value).sum::<f64>().sqrt();
    if left_norm <= f64::EPSILON || right_norm <= f64::EPSILON {
        0.0
    } else {
        dot / (left_norm * right_norm)
    }
}

fn vector_to_json(vector: &StoredVector) -> Value {
    match vector {
        StoredVector::Dense(values) => json!({ "kind": "dense", "values": values }),
        StoredVector::Sparse(values) => {
            let mut map = Map::new();
            for (token, weight) in values {
                map.insert(token.clone(), json!(weight));
            }
            json!({ "kind": "sparse", "values": Value::Object(map) })
        }
    }
}

fn vector_from_json(value: &Value) -> StoredVector {
    if value.get("kind").and_then(Value::as_str) == Some("dense") {
        return StoredVector::Dense(
            value
                .get("values")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
                .unwrap_or_default(),
        );
    }
    let sparse_value = value.get("values").unwrap_or(value);
    StoredVector::Sparse(
        sparse_value
            .as_object()
            .map(|map| {
                map.iter()
                    .filter_map(|(token, weight)| weight.as_f64().map(|weight| (token.clone(), weight)))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default(),
    )
}

async fn load_embedding_config(pool: &PgPool, account_id: i32, workspace_id: i32) -> anyhow::Result<Option<EmbeddingConfig>> {
    let model_id = config_value(pool, "embeddingModelId", account_id, workspace_id)
        .await?
        .and_then(|value| value.as_i64())
        .map(|value| value as i32);
    let Some(model_id) = model_id else { return Ok(None); };
    let Some(row) = sqlx::query(
        r#"SELECT m."modelKey" AS model_key, p.provider, p."baseURL" AS base_url, p."apiKey" AS api_key, p.config AS provider_config
           FROM "aiModels" m
           JOIN "aiProviders" p ON p.id=m."providerId"
           WHERE m.id=$1"#,
    )
    .bind(model_id)
    .fetch_optional(pool)
    .await? else {
        return Ok(None);
    };
    let provider_config = row.get::<Option<Value>, _>("provider_config");
    Ok(Some(EmbeddingConfig {
        provider: row.get::<String, _>("provider"),
        api_key: row.get::<Option<String>, _>("api_key"),
        base_url: row.get::<Option<String>, _>("base_url"),
        model_key: row.get::<String, _>("model_key"),
        api_version: provider_config
            .as_ref()
            .and_then(|value| value.get("apiVersion"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
    }))
}

async fn config_value(pool: &PgPool, key: &str, account_id: i32, workspace_id: i32) -> anyhow::Result<Option<Value>> {
    let row = sqlx::query(
        r#"SELECT config FROM config
           WHERE key=$1 AND ("userId" IS NULL OR ("userId"=$2 AND "workspaceId"=$3))
           ORDER BY CASE WHEN "userId"=$2 AND "workspaceId"=$3 THEN 0 ELSE 1 END
           LIMIT 1"#,
    )
    .bind(key)
    .bind(account_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .and_then(|row| row.try_get::<Option<Value>, _>("config").ok().flatten())
        .map(|value| crate::util::unwrap_config_value(Some(value))))
}

async fn embed_texts(config: &EmbeddingConfig, texts: &[String]) -> anyhow::Result<Vec<Vec<f64>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?;
    let provider = config.provider.to_lowercase();
    let (url, body, headers) = embedding_request(config, &provider, texts)?;
    let response = client.post(url).headers(headers).json(&body).send().await?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(anyhow!("embedding provider returned {status}: {value}"));
    }
    parse_embedding_response(&provider, &value)
}

fn embedding_request(config: &EmbeddingConfig, provider: &str, texts: &[String]) -> anyhow::Result<(String, Value, HeaderMap)> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    match provider {
        "azure" | "azureopenai" => {
            let api_key = config.api_key.as_deref().unwrap_or("");
            if !api_key.is_empty() {
                headers.insert("api-key", HeaderValue::from_str(api_key)?);
            }
            let base = config.base_url.as_deref().unwrap_or("").trim_end_matches('/');
            if base.is_empty() {
                return Err(anyhow!("Azure embedding baseURL is required"));
            }
            let api_version = config.api_version.as_deref().unwrap_or("2024-02-01");
            let url = if base.contains("/embeddings") {
                append_query(base, "api-version", api_version)
            } else {
                format!("{base}/openai/deployments/{}/embeddings?api-version={api_version}", config.model_key)
            };
            Ok((url, json!({ "input": texts }), headers))
        }
        "voyageai" => {
            set_bearer(&mut headers, config.api_key.as_deref())?;
            Ok((
                "https://api.voyageai.com/v1/embeddings".to_string(),
                json!({ "model": config.model_key, "input": texts }),
                headers,
            ))
        }
        "ollama" => {
            if let Some(api_key) = config.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                set_bearer(&mut headers, Some(api_key))?;
            }
            let base = config.base_url.as_deref().unwrap_or("http://localhost:11434").trim_end_matches('/');
            Ok((format!("{base}/api/embed"), json!({ "model": config.model_key, "input": texts }), headers))
        }
        _ => {
            set_bearer(&mut headers, config.api_key.as_deref())?;
            let base = config.base_url.as_deref().unwrap_or("https://api.openai.com/v1").trim_end_matches('/');
            let url = if base.ends_with("/embeddings") { base.to_string() } else { format!("{base}/embeddings") };
            Ok((url, json!({ "model": config.model_key, "input": texts }), headers))
        }
    }
}

fn parse_embedding_response(provider: &str, value: &Value) -> anyhow::Result<Vec<Vec<f64>>> {
    if provider == "ollama" {
        if let Some(items) = value.get("embeddings").and_then(Value::as_array) {
            return Ok(items.iter().map(number_array).collect::<Vec<_>>());
        }
        if let Some(item) = value.get("embedding").and_then(Value::as_array) {
            return Ok(vec![number_array(&Value::Array(item.clone()))]);
        }
    }
    if let Some(items) = value.get("data").and_then(Value::as_array) {
        return Ok(items
            .iter()
            .filter_map(|item| item.get("embedding"))
            .map(number_array)
            .collect::<Vec<_>>());
    }
    if let Some(items) = value.get("embeddings").and_then(Value::as_array) {
        return Ok(items.iter().map(number_array).collect::<Vec<_>>());
    }
    Err(anyhow!("embedding response does not include vectors"))
}

fn number_array(value: &Value) -> Vec<f64> {
    value.as_array().map(|items| items.iter().filter_map(Value::as_f64).collect()).unwrap_or_default()
}

fn set_bearer(headers: &mut HeaderMap, api_key: Option<&str>) -> anyhow::Result<()> {
    if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {api_key}"))?);
    }
    Ok(())
}

fn append_query(base: &str, key: &str, value: &str) -> String {
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}{key}={value}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_compatible_embedding_request_uses_embeddings_path() {
        let config = EmbeddingConfig {
            provider: "custom".to_string(),
            api_key: Some("sk-test".to_string()),
            base_url: Some("https://example.test/v1".to_string()),
            model_key: "text-embedding-3-small".to_string(),
            api_version: None,
        };
        let (url, body, headers) = embedding_request(&config, "custom", &["hello".to_string()]).unwrap();
        assert_eq!(url, "https://example.test/v1/embeddings");
        assert_eq!(body["model"], "text-embedding-3-small");
        assert_eq!(body["input"][0], "hello");
        assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer sk-test");
    }

    #[test]
    fn azure_embedding_request_uses_deployment_url() {
        let config = EmbeddingConfig {
            provider: "azure".to_string(),
            api_key: Some("az-test".to_string()),
            base_url: Some("https://example.openai.azure.com".to_string()),
            model_key: "embed-deploy".to_string(),
            api_version: Some("2024-06-01".to_string()),
        };
        let (url, body, headers) = embedding_request(&config, "azure", &["hello".to_string()]).unwrap();
        assert_eq!(url, "https://example.openai.azure.com/openai/deployments/embed-deploy/embeddings?api-version=2024-06-01");
        assert_eq!(body["input"][0], "hello");
        assert_eq!(headers.get("api-key").unwrap(), "az-test");
    }

    #[test]
    fn parses_openai_embedding_response() {
        let value = json!({
            "data": [
                { "embedding": [0.1, 0.2, 0.3] }
            ]
        });
        let vectors = parse_embedding_response("openai", &value).unwrap();
        assert_eq!(vectors, vec![vec![0.1, 0.2, 0.3]]);
    }

    #[test]
    fn parses_ollama_embedding_response() {
        let value = json!({ "embeddings": [[0.4, 0.5]] });
        let vectors = parse_embedding_response("ollama", &value).unwrap();
        assert_eq!(vectors, vec![vec![0.4, 0.5]]);
    }
}

fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else {
            if current.len() >= 2 {
                out.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
            if !ch.is_ascii() && !ch.is_whitespace() && !ch.is_control() {
                out.push(ch.to_string());
            }
        }
    }
    if current.len() >= 2 {
        out.push(current);
    }
    out
}

fn preview(content: &str) -> String {
    content.chars().take(30).collect()
}
