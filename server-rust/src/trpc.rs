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
    let user = optional_user_for_path(&state, &path, request).await;
    if requires_auth(&path) && user.is_none() {
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
            responses.push(execute_path(state.clone(), user.clone(), item_path, inputs.get(&idx).cloned().unwrap_or(Value::Null), None).await);
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
    let user = optional_user_for_path(&state, &path, request).await;
    if requires_auth(&path) && user.is_none() {
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
            responses.push(execute_path(state.clone(), user.clone(), item_path, inputs.get(&idx).cloned().unwrap_or(Value::Null), None).await);
        }
        return Json(Value::Array(responses)).into_response();
    }

    Json(execute_path(state, user, &path, body_value, None).await).into_response()
}

async fn optional_user_for_path(state: &AppState, path: &str, request: Request<Body>) -> Option<CurrentUser> {
    if !requires_auth(path) {
        return None;
    }
    let (mut parts, _) = request.into_parts();
    optional_user(&mut parts, state).await
}

fn requires_auth(path: &str) -> bool {
    path.split(',').any(|item| {
        !(item == "config.list"
            || item == "users.canRegister"
            || item == "users.register"
            || item == "users.login"
            || item.starts_with("public.")
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

async fn execute_path(state: AppState, user: Option<CurrentUser>, path: &str, input: Value, id: Option<Value>) -> Value {
    let Some(handler) = PROCEDURES.get(path) else {
        return trpc_error(&format!("Not found: {path}"), -32601, id);
    };
    let ctx = ProcedureContext { state, user };
    match handler(ctx, unwrap_superjson(input)).await {
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
    let Some(handler) = PROCEDURES.get(path) else {
        anyhow::bail!("Not found: {path}");
    };
    let ctx = ProcedureContext {
        state,
        user: Some(user),
    };
    handler(ctx, unwrap_superjson(input)).await
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
