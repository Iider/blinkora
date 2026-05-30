use crate::app::AppState;
use crate::auth::CurrentUser;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::Json;
use futures::Stream;
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

#[derive(Clone)]
struct McpSession {
    user: CurrentUser,
    sender: mpsc::Sender<Event>,
}

#[derive(Debug, Deserialize)]
pub struct MessageQuery {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

static SESSIONS: Lazy<RwLock<HashMap<String, McpSession>>> = Lazy::new(|| RwLock::new(HashMap::new()));

pub async fn sse(
    State(_state): State<AppState>,
    user: CurrentUser,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let session_id = Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel::<Event>(32);
    let endpoint = format!("/messages?sessionId={session_id}");

    let _ = sender
        .send(Event::default().event("endpoint").data(endpoint))
        .await;

    SESSIONS.write().await.insert(
        session_id.clone(),
        McpSession {
            user,
            sender: sender.clone(),
        },
    );

    let stream = futures::stream::unfold(receiver, |mut receiver| async {
        receiver.recv().await.map(|event| (Ok(event), receiver))
    });

    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

pub async fn messages(
    State(state): State<AppState>,
    Query(query): Query<MessageQuery>,
    user: CurrentUser,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let Some(session_id) = query.session_id else {
        return (StatusCode::BAD_REQUEST, "No transport found for sessionId").into_response();
    };

    let session = {
        let sessions = SESSIONS.read().await;
        sessions.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return (StatusCode::BAD_REQUEST, "No transport found for sessionId").into_response();
    };

    if session.user.id != user.id {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let response = handle_json_rpc(state, session.user, payload).await;
    if let Some(response) = response {
        let _ = session
            .sender
            .send(Event::default().event("message").json_data(response).unwrap_or_else(|_| Event::default().event("message").data("{}")))
            .await;
    }

    StatusCode::ACCEPTED.into_response()
}

async fn handle_json_rpc(state: AppState, user: CurrentUser, payload: Value) -> Option<Value> {
    if let Some(items) = payload.as_array() {
        let mut responses = Vec::new();
        for item in items {
            if let Some(response) = handle_single_json_rpc(state.clone(), user.clone(), item.clone()).await {
                responses.push(response);
            }
        }
        return (!responses.is_empty()).then_some(Value::Array(responses));
    }
    handle_single_json_rpc(state, user, payload).await
}

async fn handle_single_json_rpc(state: AppState, user: CurrentUser, payload: Value) -> Option<Value> {
    let id = payload.get("id").cloned();
    let method = payload.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = payload.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => Some(json_rpc_result(id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "blinkora-mcp-server", "version": "1.0.0-rust" }
        }))),
        "notifications/initialized" => None,
        "ping" => Some(json_rpc_result(id, json!({}))),
        "tools/list" => Some(json_rpc_result(id, json!({ "tools": tool_list() }))),
        "tools/call" => {
            let tool_name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            Some(json_rpc_result(id, call_tool(state, user, tool_name, arguments).await))
        }
        _ => Some(json_rpc_error(id, -32601, &format!("Method not found: {method}"))),
    }
}

fn tool_list() -> Value {
    json!([
        {
            "name": "searchBlinkora",
            "description": "Search Blinkora notes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "searchText": { "type": "string" },
                    "page": { "type": "number", "default": 1 },
                    "size": { "type": "number", "default": 30 },
                    "type": { "oneOf": [{ "type": "number" }, { "type": "string" }], "default": -1 },
                    "isArchived": { "type": ["boolean", "null"], "default": false },
                    "isRecycle": { "type": "boolean", "default": false }
                }
            }
        },
        {
            "name": "upsertBlinkora",
            "description": "Create a Blinkora, note, or todo entry.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string" },
                    "type": { "type": "string", "default": "blinkora" }
                },
                "required": ["content"]
            }
        },
        {
            "name": "updateBlinkora",
            "description": "Update a Blinkora note by id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "number" },
                    "content": { "type": "string" },
                    "type": { "type": "string", "default": "blinkora" }
                },
                "required": ["id", "content"]
            }
        },
        {
            "name": "deleteBlinkora",
            "description": "Move Blinkora notes to recycle bin.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "number" } }
                },
                "required": ["ids"]
            }
        }
    ])
}

async fn call_tool(state: AppState, user: CurrentUser, tool_name: &str, arguments: Value) -> Value {
    let result = match tool_name {
        "searchBlinkora" => search_blinkora(state, user, arguments).await,
        "upsertBlinkora" => upsert_blinkora(state, user, arguments, None).await,
        "updateBlinkora" => {
            let id = arguments.get("id").and_then(Value::as_i64).map(|value| value as i32);
            upsert_blinkora(state, user, arguments, id).await
        }
        "deleteBlinkora" => crate::trpc::execute_procedure(state, user, "notes.trashMany", arguments).await,
        _ => Err(anyhow::anyhow!("Unknown tool: {tool_name}")),
    };

    match result {
        Ok(value) => tool_response(value),
        Err(error) => tool_error_response(error.to_string()),
    }
}

async fn search_blinkora(state: AppState, user: CurrentUser, mut arguments: Value) -> anyhow::Result<Value> {
    normalize_note_type(&mut arguments);
    let result = crate::trpc::execute_procedure(state, user, "notes.list", arguments).await?;
    let notes = if result.is_array() {
        result
    } else {
        result
            .get("items")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()))
    };
    let count = notes.as_array().map(|items| items.len()).unwrap_or_default();
    Ok(json!({
        "success": true,
        "notes": notes,
        "message": format!("Found {count} notes matching your search criteria")
    }))
}

async fn upsert_blinkora(
    state: AppState,
    user: CurrentUser,
    mut arguments: Value,
    id: Option<i32>,
) -> anyhow::Result<Value> {
    normalize_note_type(&mut arguments);
    if let Some(id) = id {
        arguments["id"] = json!(id);
    }
    crate::trpc::execute_procedure(state, user, "notes.upsert", arguments).await
}

fn normalize_note_type(arguments: &mut Value) {
    let type_value = arguments.get("type").cloned().unwrap_or_else(|| json!(0));
    let normalized = match type_value {
        Value::String(value) => match value.to_lowercase().as_str() {
            "note" | "1" => 1,
            "todo" | "2" => 2,
            _ => 0,
        },
        Value::Number(value) => value.as_i64().unwrap_or(0) as i32,
        _ => 0,
    };
    arguments["type"] = json!(normalized);
}

fn tool_response(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value
    })
}

fn tool_error_response(message: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "structuredContent": { "success": false, "error": message },
        "isError": true
    })
}

fn json_rpc_result(id: Option<Value>, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": result
    })
}

fn json_rpc_error(id: Option<Value>, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message
        }
    })
}
