use super::common::workspace_id;
use crate::app::AppState;
use crate::auth::CurrentUser;
use crate::s3;
use crate::trpc::ProcedureContext;
use anyhow::bail;
use axum::body::Body;
use axum::extract::{Multipart, OriginalUri, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/file/upload", post(upload_file))
        .route("/file/upload-by-url", post(upload_by_url))
        .route("/file/delete", post(delete_file))
        .route("/file/*path", get(serve_file))
        .route("/s3file/*path", get(serve_file))
}

async fn upload_file(
    user: CurrentUser,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ctx = ProcedureContext {
        state: state.clone(),
        user: Some(user.clone()),
    };
    let workspace_id = workspace_id(&ctx).await.map_err(internal_error)?;

    let mut original_name = None;
    let mut content_type = String::new();
    let mut bytes = Vec::new();
    let mut metadata = json!({});

    while let Some(field) = multipart.next_field().await.map_err(bad_request)? {
        let Some(name) = field.name().map(ToString::to_string) else {
            continue;
        };
        if name == "file" {
            original_name = Some(
                field
                    .file_name()
                    .map(sanitize_file_name)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| format!("upload_{}", chrono::Utc::now().timestamp_millis())),
            );
            content_type = field.content_type().unwrap_or("").to_string();
            bytes = field.bytes().await.map_err(bad_request)?.to_vec();
        } else {
            let value = field.text().await.unwrap_or_default();
            match name.as_str() {
                "isUserVoiceRecording" if value == "true" => {
                    metadata["isUserVoiceRecording"] = json!(true)
                }
                "audioDuration" if !value.is_empty() => metadata["audioDuration"] = json!(value),
                "audioDurationSeconds" => {
                    if let Ok(seconds) = value.parse::<i64>() {
                        metadata["audioDurationSeconds"] = json!(seconds);
                    }
                }
                _ => {}
            }
        }
    }

    let Some(file_name) = original_name else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "No files received." })),
        ));
    };

    let _write_guard = state.write_guard().await;
    let upload = persist_upload(&state, &file_name, &bytes, &content_type)
        .await
        .map_err(internal_error)?;
    let metadata_value = if metadata
        .as_object()
        .map(|map| !map.is_empty())
        .unwrap_or(false)
    {
        Some(metadata)
    } else {
        None
    };
    let insert_result = sqlx::query(
        r#"INSERT INTO attachments (name, path, size, type, "accountId", "workspaceId", metadata, "updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,blinkora_now())"#,
    )
    .bind(&file_name)
    .bind(&upload.api_path)
    .bind(bytes.len() as i64)
    .bind(&content_type)
    .bind(user.id)
    .bind(workspace_id)
    .bind(metadata_value)
    .execute(state.pool())
    .await;
    if let Err(error) = insert_result {
        if let Err(cleanup_error) = upload.rollback().await {
            tracing::error!(%cleanup_error, "failed to remove an attachment after its database insert failed");
        }
        return Err(internal_error(error));
    }

    Ok(Json(json!({
        "Message": "Success",
        "status": 200,
        "filePath": upload.api_path,
        "fileName": file_name,
        "path": upload.api_path,
        "name": file_name,
        "type": content_type,
        "size": bytes.len()
    })))
}

#[derive(Deserialize)]
struct UploadByUrlRequest {
    url: String,
}

async fn upload_by_url(
    user: CurrentUser,
    State(state): State<AppState>,
    Json(req): Json<UploadByUrlRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if req.url.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "No URL provided" })),
        ));
    }
    let ctx = ProcedureContext {
        state: state.clone(),
        user: Some(user.clone()),
    };
    let workspace_id = workspace_id(&ctx).await.map_err(internal_error)?;
    let response = reqwest::get(&req.url).await.map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Failed to fetch file from URL" })),
        )
    })?;
    if !response.status().is_success() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Failed to fetch file from URL" })),
        ));
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let name = req
        .url
        .split('?')
        .next()
        .and_then(|value| value.rsplit('/').next())
        .map(sanitize_file_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("upload_{}", chrono::Utc::now().timestamp_millis()));
    let bytes = response.bytes().await.map_err(internal_error)?;
    let _write_guard = state.write_guard().await;
    let upload = persist_upload(&state, &name, &bytes, &content_type)
        .await
        .map_err(internal_error)?;
    let insert_result = sqlx::query(
        r#"INSERT INTO attachments (name, path, size, type, "accountId", "workspaceId", "updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,blinkora_now())"#,
    )
    .bind(&name)
    .bind(&upload.api_path)
    .bind(bytes.len() as i64)
    .bind(&content_type)
    .bind(user.id)
    .bind(workspace_id)
    .execute(state.pool())
    .await;
    if let Err(error) = insert_result {
        if let Err(cleanup_error) = upload.rollback().await {
            tracing::error!(%cleanup_error, "failed to remove a URL attachment after its database insert failed");
        }
        return Err(internal_error(error));
    }

    Ok(Json(json!({
        "Message": "Success",
        "status": 200,
        "filePath": upload.api_path,
        "fileName": name,
        "path": upload.api_path,
        "name": name,
        "originalURL": req.url,
        "type": content_type,
        "size": bytes.len()
    })))
}

#[derive(Deserialize)]
struct DeleteFileRequest {
    attachment_path: String,
}

async fn delete_file(
    user: CurrentUser,
    State(state): State<AppState>,
    Json(req): Json<DeleteFileRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if req.attachment_path.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing attachment_path parameter" })),
        ));
    }
    let ctx = ProcedureContext {
        state: state.clone(),
        user: Some(user.clone()),
    };
    let workspace_id = workspace_id(&ctx).await.map_err(internal_error)?;
    let _write_guard = state.write_guard().await;
    let row = sqlx::query(
        r#"SELECT a.id, a.path, a."accountId", a."workspaceId", n."accountId" AS "noteAccountId", n."workspaceId" AS "noteWorkspaceId"
           FROM attachments a
           LEFT JOIN notes n ON n.id=a."noteId"
           WHERE a.path=$1"#,
    )
    .bind(&req.attachment_path)
    .fetch_optional(state.pool())
    .await
    .map_err(internal_error)?;
    let Some(row) = row else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "File not found" })),
        ));
    };
    let attachment_account = row.get::<Option<i32>, _>("accountId");
    let attachment_workspace = row.get::<Option<i32>, _>("workspaceId");
    let note_account = row.get::<Option<i32>, _>("noteAccountId");
    let note_workspace = row.get::<Option<i32>, _>("noteWorkspaceId");
    let is_owner = user.role == "superadmin"
        || attachment_account == Some(user.id)
        || note_account == Some(user.id);
    let is_same_workspace =
        attachment_workspace == Some(workspace_id) || note_workspace == Some(workspace_id);
    if !is_owner || !is_same_workspace {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Forbidden: You don't have permission to delete this file" })),
        ));
    }

    let staged_deletions = crate::attachment_files::stage_attachment_deletions(
        &ctx,
        std::slice::from_ref(&req.attachment_path),
    )
    .await
    .map_err(internal_error)?;
    let database_result: anyhow::Result<()> = async {
        let mut tx = state.pool().begin().await?;
        sqlx::query(r#"DELETE FROM attachments WHERE id=$1"#)
            .bind(row.get::<i32, _>("id"))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    .await;
    if let Err(database_error) = database_result {
        if let Err(rollback_error) =
            crate::attachment_files::rollback_attachment_deletions(staged_deletions).await
        {
            tracing::error!(%rollback_error, "file delete database transaction and physical rollback both failed");
        }
        return Err(internal_error(database_error));
    }
    if let Err(error) =
        crate::attachment_files::finalize_attachment_deletions(staged_deletions).await
    {
        tracing::error!(%error, "file row was deleted but private file staging cleanup failed");
    }
    Ok(Json(json!({ "Message": "Success", "status": 200 })))
}

async fn serve_file(
    user: Option<CurrentUser>,
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(path): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let decoded = match urlencoding::decode(&path) {
        Ok(value) => value.to_string(),
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "Invalid path"),
    };
    let relative_path = match safe_relative_path(&decoded, true) {
        Ok(path) => path,
        Err(err) => return json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    };
    let api_path = if uri.path().starts_with("/api/s3file/") {
        format!("/api/s3file/{decoded}")
    } else {
        format!("/api/file/{decoded}")
    };
    let Some(current_user) = user.as_ref() else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if decoded.starts_with("temp/") && current_user.is_workspace_agent() {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    if decoded.ends_with(".bko") {
        if current_user.role != "superadmin" {
            return json_error(StatusCode::UNAUTHORIZED, "Only superadmin can access");
        }
    } else if let Err(response) = authorize_file_read(current_user, &state, &api_path).await {
        return response;
    }

    let (bytes, content_type) = if api_path.starts_with("/api/s3file/") {
        let Ok(Some(config)) = s3::load_s3_config(&state).await else {
            return json_error(StatusCode::NOT_FOUND, "File not found");
        };
        let Some(key) = s3_key_from_api_path(&api_path) else {
            return json_error(StatusCode::BAD_REQUEST, "Invalid path");
        };
        let Ok(bytes) = s3::get_object(&config, &key).await else {
            return json_error(StatusCode::NOT_FOUND, "File not found");
        };
        (bytes, content_type_for_name(&decoded).to_string())
    } else {
        let full_path = files_root(&state).join(relative_path);
        let Ok(bytes) = tokio::fs::read(&full_path).await else {
            return json_error(StatusCode::NOT_FOUND, "File not found");
        };
        (bytes, content_type_for_path(&full_path).to_string())
    };
    let mut response = Body::from(bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    let cache_control = if decoded.starts_with("temp/") || decoded.ends_with(".bko") {
        "private, no-store"
    } else {
        "private, max-age=3600"
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    if query
        .get("download")
        .map(|value| value == "true")
        .unwrap_or(false)
    {
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
    }
    response
}

async fn authorize_file_read(
    user: &CurrentUser,
    state: &AppState,
    api_path: &str,
) -> Result<(), Response> {
    let ctx = ProcedureContext {
        state: state.clone(),
        user: Some(user.clone()),
    };
    let workspace_id = workspace_id(&ctx)
        .await
        .map_err(|_| json_error(StatusCode::UNAUTHORIZED, "Unauthorized"))?;
    let row = sqlx::query(
        r#"SELECT a."accountId", a."workspaceId", n."accountId" AS "noteAccountId", n."workspaceId" AS "noteWorkspaceId"
           FROM attachments a
           LEFT JOIN notes n ON n.id=a."noteId"
           WHERE a.path=$1"#,
    )
    .bind(api_path)
    .fetch_optional(state.pool())
    .await
    .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "Error checking file permissions"))?;
    let Some(row) = row else {
        return Ok(());
    };
    let is_owner = user.role == "superadmin"
        || row.get::<Option<i32>, _>("accountId") == Some(user.id)
        || row.get::<Option<i32>, _>("noteAccountId") == Some(user.id);
    let is_same_workspace = row.get::<Option<i32>, _>("workspaceId") == Some(workspace_id)
        || row.get::<Option<i32>, _>("noteWorkspaceId") == Some(workspace_id);
    if is_owner && is_same_workspace {
        Ok(())
    } else {
        Err(json_error(StatusCode::UNAUTHORIZED, "Unauthorized"))
    }
}

struct UploadResult {
    api_path: String,
    storage: UploadStorage,
}

enum UploadStorage {
    Local(PathBuf),
    S3 { config: s3::S3Config, key: String },
}

impl UploadResult {
    async fn rollback(&self) -> anyhow::Result<()> {
        match &self.storage {
            UploadStorage::Local(path) => match tokio::fs::remove_file(path).await {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            },
            UploadStorage::S3 { config, key } => s3::delete_object(config, key).await,
        }
    }
}

async fn persist_upload(
    state: &AppState,
    original_name: &str,
    bytes: &[u8],
    content_type: &str,
) -> anyhow::Result<UploadResult> {
    let safe_name = sanitize_file_name(original_name);
    let extension = FsPath::new(&safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let base_name = FsPath::new(&safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_file_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "upload".to_string());
    if let Some(config) = s3::load_s3_config(state).await? {
        let file_name = format!(
            "{}_{}{}",
            base_name,
            chrono::Utc::now().timestamp_millis(),
            extension
        );
        let key = s3::object_key(&config, &file_name);
        s3::put_object(&config, &key, bytes, content_type).await?;
        return Ok(UploadResult {
            api_path: format!("/api/s3file/{key}"),
            storage: UploadStorage::S3 { config, key },
        });
    }
    let stored_name = format!(
        "{}_{}",
        chrono::Utc::now().timestamp_millis(),
        Uuid::new_v4().simple()
    );
    let file_name = format!("{stored_name}{extension}");
    let root = files_root(state);
    tokio::fs::create_dir_all(&root).await?;
    set_private_directory(&root).await?;
    let path = root.join(&file_name);
    let write_result = async {
        let mut file = tokio::fs::File::create(&path).await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        set_private_file(&path).await
    }
    .await;
    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(UploadResult {
        api_path: format!("/api/file/{file_name}"),
        storage: UploadStorage::Local(path),
    })
}

async fn set_private_directory(path: &FsPath) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(path).await?.permissions();
        permissions.set_mode(0o700);
        tokio::fs::set_permissions(path, permissions).await?;
    }
    Ok(())
}

async fn set_private_file(path: &FsPath) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(path).await?.permissions();
        permissions.set_mode(0o600);
        tokio::fs::set_permissions(path, permissions).await?;
    }
    Ok(())
}

fn files_root(state: &AppState) -> PathBuf {
    FsPath::new(&state.config.data_dir).join("files")
}

fn s3_key_from_api_path(path: &str) -> Option<String> {
    let key = path.strip_prefix("/api/s3file/")?;
    if key.contains('\0')
        || key.contains('\\')
        || key.starts_with('/')
        || key.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(key.to_string())
}

fn safe_relative_path(path: &str, allow_temp: bool) -> anyhow::Result<PathBuf> {
    if path.contains('\0') || path.contains('\\') {
        bail!("Invalid path characters");
    }
    if path.starts_with('/') || path.split('/').any(|part| part == "..") {
        bail!("Invalid path");
    }
    if path.starts_with("temp/") && !allow_temp {
        bail!("Access denied");
    }
    Ok(PathBuf::from(path))
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
                || ch.is_whitespace()
                || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    sanitized.trim_matches('_').to_string()
}

fn content_type_for_path(path: &FsPath) -> &'static str {
    content_type_for_extension(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or(""),
    )
}

fn content_type_for_name(name: &str) -> &'static str {
    content_type_for_extension(
        FsPath::new(name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or(""),
    )
}

fn content_type_for_extension(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn bad_request(err: impl std::fmt::Display) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": err.to_string() })),
    )
}

fn internal_error(err: impl std::fmt::Display) -> (StatusCode, Json<Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": err.to_string() })),
    )
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}
