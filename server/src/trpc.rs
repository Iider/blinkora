use crate::app::AppState;
use crate::auth::{optional_user, CurrentUser};
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::future::BoxFuture;
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

pub type ProcedureFuture = BoxFuture<'static, anyhow::Result<Value>>;
pub type ProcedureHandler = fn(ProcedureContext, Value) -> ProcedureFuture;

#[derive(Clone)]
pub struct ProcedureContext {
    pub state: AppState,
    pub user: Option<CurrentUser>,
}

static PROCEDURES: Lazy<HashMap<&'static str, ProcedureHandler>> = Lazy::new(|| {
    let mut registry: HashMap<&'static str, ProcedureHandler> = HashMap::new();
    crate::handlers::register_procedures(&mut registry);
    registry
});

#[derive(Debug, Deserialize)]
pub struct TrpcQuery {
    input: Option<String>,
    batch: Option<String>,
}

pub async fn trpc_get(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Query(query): Query<TrpcQuery>,
    request: Request<Body>,
) -> Response {
    let has_agent_token = has_agent_token(&request);
    let user = optional_user_for_path(&state, &path, request).await;
    if (requires_auth(&path) || has_agent_token) && user.is_none() {
        return auth_error_response(&path, query.batch.as_deref() == Some("1"));
    }

    let input = query
        .input
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .unwrap_or(Value::Null);
    if query.batch.as_deref() == Some("1") {
        let inputs = parse_batch_inputs(input);
        let mut responses = Vec::new();
        for (idx, item_path) in path.split(',').enumerate() {
            responses.push(
                execute_path(
                    state.clone(),
                    user.clone(),
                    item_path,
                    inputs.get(&idx).cloned().unwrap_or(Value::Null),
                    None,
                )
                .await,
            );
        }
        return Json(Value::Array(responses)).into_response();
    }
    Json(execute_path(state, user, &path, input, None).await).into_response()
}

pub async fn trpc_post(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Query(query): Query<TrpcQuery>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(_) => return Json(trpc_error("Failed to read body", -32700, None)).into_response(),
    };
    let request = Request::from_parts(parts, Body::empty());
    let has_agent_token = has_agent_token(&request);
    let user = optional_user_for_path(&state, &path, request).await;
    if (requires_auth(&path) || has_agent_token) && user.is_none() {
        return auth_error_response(&path, query.batch.as_deref() == Some("1"));
    }

    let body_value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)
    };

    if query.batch.as_deref() == Some("1") {
        let inputs = parse_batch_inputs(body_value);
        let mut responses = Vec::new();
        for (idx, item_path) in path.split(',').enumerate() {
            responses.push(
                execute_path(
                    state.clone(),
                    user.clone(),
                    item_path,
                    inputs.get(&idx).cloned().unwrap_or(Value::Null),
                    None,
                )
                .await,
            );
        }
        return Json(Value::Array(responses)).into_response();
    }

    Json(execute_path(state, user, &path, body_value, None).await).into_response()
}

async fn optional_user_for_path(
    state: &AppState,
    path: &str,
    request: Request<Body>,
) -> Option<CurrentUser> {
    if !requires_auth(path) && !has_auth_token(&request) {
        return None;
    }
    let (mut parts, _) = request.into_parts();
    optional_user(&mut parts, state).await
}

fn has_auth_token(request: &Request<Body>) -> bool {
    if request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|auth| auth.strip_prefix("Bearer "))
        .is_some_and(|token| !token.trim().is_empty())
    {
        return true;
    }
    request
        .uri()
        .query()
        .and_then(|query| {
            query.split('&').find_map(|part| {
                let (key, value) = part.split_once('=')?;
                (key == "token" && !value.trim().is_empty()).then_some(true)
            })
        })
        .unwrap_or(false)
}

fn has_agent_token(request: &Request<Body>) -> bool {
    if let Some(auth) = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
    {
        if auth
            .strip_prefix("Bearer ")
            .is_some_and(|token| token.starts_with("bkws_"))
        {
            return true;
        }
    }
    request
        .uri()
        .query()
        .and_then(|query| {
            query.split('&').find_map(|part| {
                let (key, value) = part.split_once('=')?;
                (key == "token").then_some(value.starts_with("bkws_"))
            })
        })
        .unwrap_or(false)
}

fn requires_auth(path: &str) -> bool {
    path.split(',').any(|item| {
        !(item == "config.list"
            || item == "users.canRegister"
            || item == "users.register"
            || item == "users.login"
            || item == "system.serverVersion"
            || item == "fonts.list"
            || item == "fonts.getFontData"
            || item == "fonts.getByName")
    })
}

fn auth_error_response(path: &str, batch: bool) -> Response {
    let make = |item_path: &str| {
        json!({
            "error": {
                "json": {
                    "message": "Unauthorized",
                    "code": -32001,
                    "data": {
                        "code": "UNAUTHORIZED",
                        "httpStatus": 401,
                        "path": item_path
                    }
                }
            }
        })
    };
    let value = if batch {
        Value::Array(path.split(',').map(make).collect())
    } else {
        make(path)
    };
    (StatusCode::UNAUTHORIZED, Json(value)).into_response()
}

fn parse_batch_inputs(value: Value) -> HashMap<usize, Value> {
    let mut out = HashMap::new();
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if let Ok(idx) = key.parse::<usize>() {
                    out.insert(idx, unwrap_superjson(value));
                }
            }
        }
        Value::Array(items) => {
            for (idx, value) in items.into_iter().enumerate() {
                out.insert(idx, unwrap_superjson(value));
            }
        }
        _ => {}
    }
    out
}

async fn execute_path(
    state: AppState,
    user: Option<CurrentUser>,
    path: &str,
    input: Value,
    id: Option<Value>,
) -> Value {
    if let Some(user) = user.as_ref() {
        if !user.can_call_procedure(path) {
            return trpc_forbidden(path, id);
        }
    }

    let Some(handler) = PROCEDURES.get(path) else {
        return trpc_error(&format!("Not found: {path}"), -32601, id);
    };
    let ctx = ProcedureContext { state, user };
    let result = if is_write_procedure(path) {
        let _write_guard = ctx.state.write_guard().await;
        handler(ctx, unwrap_superjson(input)).await
    } else {
        handler(ctx, unwrap_superjson(input)).await
    };
    match result {
        Ok(result) => {
            let mut response = json!({ "result": { "data": { "json": result } } });
            if let Some(id) = id {
                response["id"] = id;
            }
            response
        }
        Err(err) => trpc_error(&err.to_string(), -32603, id),
    }
}

pub async fn execute_procedure(
    state: AppState,
    user: CurrentUser,
    path: &str,
    input: Value,
) -> anyhow::Result<Value> {
    if !user.can_call_procedure(path) {
        anyhow::bail!("Forbidden");
    }

    let Some(handler) = PROCEDURES.get(path) else {
        anyhow::bail!("Not found: {path}");
    };
    let ctx = ProcedureContext {
        state,
        user: Some(user),
    };
    if is_write_procedure(path) {
        let _write_guard = ctx.state.write_guard().await;
        handler(ctx, unwrap_superjson(input)).await
    } else {
        handler(ctx, unwrap_superjson(input)).await
    }
}

/// Mutations are intentionally listed rather than inferred from HTTP method:
/// tRPC procedures use both GET and POST, and a few "list" paths repair a
/// missing default workspace. Keeping this contract next to dispatch makes
/// new writers opt in during review.
pub fn is_write_procedure(path: &str) -> bool {
    matches!(
        path,
        "agentTokens.create"
            | "agentTokens.revoke"
            | "attachments.createFolder"
            | "attachments.rename"
            | "attachments.move"
            | "attachments.delete"
            | "attachments.deleteMany"
            | "comments.create"
            | "comments.update"
            | "comments.delete"
            | "comments.convertToTodo"
            | "config.update"
            | "config.saveAndValidateS3"
            | "fonts.create"
            | "fonts.update"
            | "fonts.delete"
            | "fonts.upload"
            | "notes.reviewNote"
            | "notes.upsert"
            | "notes.moveToWorkspace"
            | "notes.updateMany"
            | "notes.trashMany"
            | "notes.deleteMany"
            | "notes.addReference"
            | "notes.removeReference"
            | "notes.setReferences"
            | "notes.clearRecycleBin"
            | "notes.updateAttachmentsOrder"
            | "notes.updateNotesOrder"
            | "tags.cleanupOrphanTags"
            | "tags.updateTagMany"
            | "tags.updateTagName"
            | "tags.updateTagIcon"
            | "tags.deleteOnlyTag"
            | "tags.deleteTagWithAllNote"
            | "tags.updateTagOrder"
            | "users.register"
            | "users.regenToken"
            | "users.upsertUser"
            | "workspaces.create"
            | "workspaces.update"
            | "workspaces.delete"
            | "workspaces.setDefault"
            | "workspaces.list"
    )
}

fn unwrap_superjson(value: Value) -> Value {
    if let Value::Object(mut map) = value {
        if let Some(json) = map.remove("json") {
            return json;
        }
        return Value::Object(map);
    }
    value
}

fn trpc_error(message: &str, code: i32, id: Option<Value>) -> Value {
    let mut value = json!({
        "error": {
            "json": {
                "message": message,
                "code": code,
                "data": {
                    "code": "INTERNAL_SERVER_ERROR",
                    "httpStatus": 500
                }
            }
        }
    });
    if let Some(id) = id {
        value["id"] = id;
    }
    value
}

fn trpc_forbidden(path: &str, id: Option<Value>) -> Value {
    let mut value = json!({
        "error": {
            "json": {
                "message": "Forbidden",
                "code": -32003,
                "data": {
                    "code": "FORBIDDEN",
                    "httpStatus": 403,
                    "path": path
                }
            }
        }
    });
    if let Some(id) = id {
        value["id"] = id;
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_auth_token_detects_regular_bearer_token() {
        let request = Request::builder()
            .uri("/api/trpc/config.list")
            .header("authorization", "Bearer account-token")
            .body(Body::empty())
            .unwrap();

        assert!(has_auth_token(&request));
        assert!(!has_agent_token(&request));
    }

    #[test]
    fn has_auth_token_detects_query_token() {
        let request = Request::builder()
            .uri("/api/trpc/config.list?token=account-token")
            .body(Body::empty())
            .unwrap();

        assert!(has_auth_token(&request));
    }

    #[test]
    fn has_auth_token_ignores_missing_or_empty_token() {
        let missing = Request::builder()
            .uri("/api/trpc/config.list")
            .body(Body::empty())
            .unwrap();
        let empty = Request::builder()
            .uri("/api/trpc/config.list?token=")
            .body(Body::empty())
            .unwrap();

        assert!(!has_auth_token(&missing));
        assert!(!has_auth_token(&empty));
    }
}
