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
use sqlx::Row;
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

static SESSIONS: Lazy<RwLock<HashMap<String, McpSession>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

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

    if session.user.auth_session_key() != user.auth_session_key() {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let response = handle_json_rpc(state, session.user, payload).await;
    if let Some(response) = response {
        let _ = session
            .sender
            .send(
                Event::default()
                    .event("message")
                    .json_data(response)
                    .unwrap_or_else(|_| Event::default().event("message").data("{}")),
            )
            .await;
    }

    StatusCode::ACCEPTED.into_response()
}

async fn handle_json_rpc(state: AppState, user: CurrentUser, payload: Value) -> Option<Value> {
    if let Some(items) = payload.as_array() {
        let mut responses = Vec::new();
        for item in items {
            if let Some(response) =
                handle_single_json_rpc(state.clone(), user.clone(), item.clone()).await
            {
                responses.push(response);
            }
        }
        return (!responses.is_empty()).then_some(Value::Array(responses));
    }
    handle_single_json_rpc(state, user, payload).await
}

async fn handle_single_json_rpc(
    state: AppState,
    user: CurrentUser,
    payload: Value,
) -> Option<Value> {
    let id = payload.get("id").cloned();
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = payload.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => Some(json_rpc_result(
            id,
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "blinkora-mcp-server", "version": "1.0.0-rust" }
            }),
        )),
        "notifications/initialized" => None,
        "ping" => Some(json_rpc_result(id, json!({}))),
        "tools/list" => Some(json_rpc_result(id, json!({ "tools": tool_list(&user) }))),
        "tools/call" => {
            let tool_name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            Some(json_rpc_result(
                id,
                call_tool(state, user, tool_name, arguments).await,
            ))
        }
        _ => Some(json_rpc_error(
            id,
            -32601,
            &format!("Method not found: {method}"),
        )),
    }
}

fn tool_list(user: &CurrentUser) -> Value {
    let tools = vec![
        {
            json!({
                "name": "getWorkspaceContext",
                "description": "Get the current account and workspace bound to this token.",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            })
        },
        {
            json!({
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
                        "isRecycle": { "type": "boolean", "default": false },
                        "metadata": { "type": ["object", "null"], "description": "Top-level metadata subset to match exactly." },
                        "metadataContains": { "type": ["object", "null"], "description": "Alias for metadata." }
                    }
                }
            })
        },
        {
            json!({
                "name": "getBlinkora",
                "description": "Get one Blinkora note by id.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "number" }
                    },
                    "required": ["id"]
                }
            })
        },
        {
            json!({
                "name": "upsertBlinkora",
                "description": "Create a Blinkora, note, or todo entry.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "content": { "type": "string" },
                        "type": { "oneOf": [{ "type": "number" }, { "type": "string" }], "default": "blinkora" },
                        "metadata": { "type": ["object", "null"] },
                        "references": { "type": ["array", "null"], "items": { "oneOf": [{ "type": "number" }, { "type": "object" }] } }
                    },
                    "required": ["content"]
                }
            })
        },
        {
            json!({
                "name": "updateBlinkora",
                "description": "Update a Blinkora note by id.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "number" },
                        "content": { "type": "string" },
                        "type": { "oneOf": [{ "type": "number" }, { "type": "string" }], "default": "blinkora" },
                        "metadata": { "type": ["object", "null"] },
                        "references": { "type": ["array", "null"], "items": { "oneOf": [{ "type": "number" }, { "type": "object" }] } }
                    },
                    "required": ["id"]
                }
            })
        },
        {
            json!({
                "name": "listReferences",
                "description": "List outgoing and incoming references for one note.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "noteId": { "type": "number" },
                        "id": { "type": "number" }
                    }
                }
            })
        },
        {
            json!({
                "name": "addReference",
                "description": "Create an outgoing reference from one note to another note in the same workspace.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "fromNoteId": { "type": "number" },
                        "toNoteId": { "type": "number" }
                    },
                    "required": ["fromNoteId", "toNoteId"]
                }
            })
        },
        {
            json!({
                "name": "removeReference",
                "description": "Remove one note reference by id or by fromNoteId/toNoteId.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "number" },
                        "fromNoteId": { "type": "number" },
                        "toNoteId": { "type": "number" }
                    }
                }
            })
        },
        {
            json!({
                "name": "setReferences",
                "description": "Replace all outgoing references for one note.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "fromNoteId": { "type": "number" },
                        "toNoteIds": { "type": "array", "items": { "type": "number" } },
                        "references": { "type": "array", "items": { "oneOf": [{ "type": "number" }, { "type": "object" }] } }
                    },
                    "required": ["fromNoteId"]
                }
            })
        },
        {
            json!({
                "name": "deleteBlinkora",
                "description": "Move Blinkora notes to recycle bin.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "ids": { "type": "array", "items": { "type": "number" } }
                    },
                    "required": ["ids"]
                }
            })
        },
        {
            json!({
                "name": "listComments",
                "description": "List comments for one Blinkora note.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "noteId": { "type": "number" }
                    },
                    "required": ["noteId"]
                }
            })
        },
        {
            json!({
                "name": "createComment",
                "description": "Create a comment for one Blinkora note.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "noteId": { "type": "number" },
                        "content": { "type": "string" },
                        "kind": { "type": "string", "default": "annotation" },
                        "parentId": { "type": ["number", "null"] },
                        "metadata": { "type": ["object", "null"] }
                    },
                    "required": ["noteId", "content"]
                }
            })
        },
        {
            json!({
                "name": "updateComment",
                "description": "Update a Blinkora comment.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "number" },
                        "content": { "type": "string" },
                        "kind": { "type": "string" },
                        "status": { "type": "string" },
                        "metadata": { "type": ["object", "null"] }
                    },
                    "required": ["id"]
                }
            })
        },
        {
            json!({
                "name": "listTagTree",
                "description": "List the tag tree for the current workspace.",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            })
        },
    ];

    Value::Array(
        tools
            .into_iter()
            .filter(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| user.can_call_mcp_tool(name))
            })
            .collect(),
    )
}

async fn call_tool(state: AppState, user: CurrentUser, tool_name: &str, arguments: Value) -> Value {
    if !user.can_call_mcp_tool(tool_name) {
        return tool_error_response("Forbidden".to_string());
    }

    let result = match tool_name {
        "getWorkspaceContext" => get_workspace_context(state, user).await,
        "searchBlinkora" => search_blinkora(state, user, arguments).await,
        "getBlinkora" => {
            crate::trpc::execute_procedure(state, user, "notes.detail", arguments).await
        }
        "upsertBlinkora" => upsert_blinkora(state, user, arguments, None).await,
        "updateBlinkora" => {
            let id = arguments
                .get("id")
                .and_then(Value::as_i64)
                .map(|value| value as i32);
            upsert_blinkora(state, user, arguments, id).await
        }
        "listReferences" => {
            crate::trpc::execute_procedure(state, user, "notes.noteReferenceList", arguments).await
        }
        "addReference" => {
            crate::trpc::execute_procedure(state, user, "notes.addReference", arguments).await
        }
        "removeReference" => {
            crate::trpc::execute_procedure(state, user, "notes.removeReference", arguments).await
        }
        "setReferences" => {
            crate::trpc::execute_procedure(state, user, "notes.setReferences", arguments).await
        }
        "deleteBlinkora" => {
            crate::trpc::execute_procedure(state, user, "notes.trashMany", arguments).await
        }
        "listComments" => {
            crate::trpc::execute_procedure(state, user, "comments.list", arguments).await
        }
        "createComment" => {
            crate::trpc::execute_procedure(state, user, "comments.create", arguments).await
        }
        "updateComment" => {
            crate::trpc::execute_procedure(state, user, "comments.update", arguments).await
        }
        "listTagTree" => list_tag_tree(state, user).await,
        _ => Err(anyhow::anyhow!("Unknown tool: {tool_name}")),
    };

    match result {
        Ok(value) => tool_response(value),
        Err(error) => tool_error_response(error.to_string()),
    }
}

async fn get_workspace_context(state: AppState, user: CurrentUser) -> anyhow::Result<Value> {
    let workspace_id = match user.workspace_id {
        Some(id) => id,
        None => {
            if let Some(id) = sqlx::query_scalar::<_, i32>(
                r#"SELECT id FROM workspaces WHERE "accountId"=$1 AND "isDefault"=true LIMIT 1"#,
            )
            .bind(user.id)
            .fetch_optional(state.pool())
            .await?
            {
                id
            } else {
                sqlx::query_scalar::<_, i32>(
                    r#"SELECT id FROM workspaces WHERE "accountId"=$1 ORDER BY id ASC LIMIT 1"#,
                )
                .bind(user.id)
                .fetch_optional(state.pool())
                .await?
                .ok_or_else(|| anyhow::anyhow!("workspace not found"))?
            }
        }
    };
    let row = sqlx::query(
        r#"SELECT id, name, description, icon, color, "accountId", "isDefault", "createdAt", "updatedAt"
           FROM workspaces WHERE id=$1 AND "accountId"=$2"#,
    )
    .bind(workspace_id)
    .bind(user.id)
    .fetch_one(state.pool())
    .await?;
    Ok(json!({
        "success": true,
        "account": {
            "id": user.id,
            "name": user.name,
            "nickname": user.nickname,
            "role": user.role,
            "authKind": if user.is_workspace_agent() { "workspaceAgent" } else { "account" },
            "agentTokenId": user.agent_token_id
        },
        "workspace": {
            "id": row.get::<i32, _>("id"),
            "name": row.get::<String, _>("name"),
            "description": row.get::<String, _>("description"),
            "icon": row.get::<String, _>("icon"),
            "color": row.get::<String, _>("color"),
            "accountId": row.get::<i32, _>("accountId"),
            "isDefault": row.get::<bool, _>("isDefault"),
            "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
            "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
        }
    }))
}

async fn search_blinkora(
    state: AppState,
    user: CurrentUser,
    mut arguments: Value,
) -> anyhow::Result<Value> {
    normalize_note_type(&mut arguments, -1);
    let result = crate::trpc::execute_procedure(state, user, "notes.list", arguments).await?;
    let notes = if result.is_array() {
        result
    } else {
        result
            .get("items")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()))
    };
    let count = notes
        .as_array()
        .map(|items| items.len())
        .unwrap_or_default();
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
    normalize_note_type(&mut arguments, 0);
    if let Some(id) = id {
        arguments["id"] = json!(id);
    }
    crate::trpc::execute_procedure(state, user, "notes.upsert", arguments).await
}

async fn list_tag_tree(state: AppState, user: CurrentUser) -> anyhow::Result<Value> {
    let tags = crate::trpc::execute_procedure(state, user, "tags.list", json!({})).await?;
    let tree = match tags.as_array() {
        Some(items) => build_tag_tree(items, 0),
        None => Vec::new(),
    };
    Ok(json!({
        "success": true,
        "tags": tree
    }))
}

fn build_tag_tree(tags: &[Value], parent: i64) -> Vec<Value> {
    tags.iter()
        .filter(|tag| tag.get("parent").and_then(Value::as_i64).unwrap_or(0) == parent)
        .map(|tag| {
            let mut node = tag.clone();
            let id = node.get("id").and_then(Value::as_i64).unwrap_or_default();
            node["children"] = Value::Array(build_tag_tree(tags, id));
            node
        })
        .collect()
}

fn normalize_note_type(arguments: &mut Value, default_type: i32) {
    let type_value = arguments
        .get("type")
        .cloned()
        .unwrap_or_else(|| json!(default_type));
    let normalized = match type_value {
        Value::String(value) => match value.to_lowercase().as_str() {
            "all" | "-1" => -1,
            "note" | "1" => 1,
            "todo" | "2" => 2,
            "blinkora" | "0" => 0,
            _ => default_type,
        },
        Value::Number(value) => value.as_i64().unwrap_or(0) as i32,
        _ => default_type,
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
