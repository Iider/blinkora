use crate::app::AppState;
use async_trait::async_trait;
use axum::extract::FromRequestParts;
use axum::http::{request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use sqlx::PgPool;
use sqlx::Row;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub id: i32,
    pub name: String,
    pub nickname: String,
    pub role: String,
    pub sub: String,
    pub iat: usize,
    pub exp: usize,
}

#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: i32,
    pub name: String,
    pub nickname: String,
    pub role: String,
    pub sub: String,
    pub workspace_id: Option<i32>,
    pub auth_kind: AuthKind,
    pub agent_token_id: Option<i32>,
    pub agent_permissions: AgentPermissions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthKind {
    Account,
    WorkspaceAgent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPermissions {
    pub notes_read: bool,
    pub notes_write: bool,
    pub comments_read: bool,
    pub comments_write: bool,
    pub tags_read: bool,
}

impl CurrentUser {
    pub fn from_claims(claims: Claims) -> Self {
        Self {
            id: claims.id,
            name: claims.name,
            nickname: claims.nickname,
            role: claims.role,
            sub: claims.sub,
            workspace_id: None,
            auth_kind: AuthKind::Account,
            agent_token_id: None,
            agent_permissions: AgentPermissions::full_account(),
        }
    }

    pub fn is_workspace_agent(&self) -> bool {
        self.auth_kind == AuthKind::WorkspaceAgent
    }

    pub fn auth_session_key(&self) -> String {
        match self.auth_kind {
            AuthKind::Account => format!("account:{}", self.id),
            AuthKind::WorkspaceAgent => format!(
                "agent:{}:{}",
                self.id,
                self.agent_token_id.unwrap_or_default()
            ),
        }
    }

    pub fn can_call_procedure(&self, path: &str) -> bool {
        if !self.is_workspace_agent() {
            return true;
        }
        self.agent_permissions.allows_procedure(path)
    }

    pub fn can_call_mcp_tool(&self, tool_name: &str) -> bool {
        if !self.is_workspace_agent() {
            return true;
        }
        self.agent_permissions.allows_mcp_tool(tool_name)
    }
}

impl AgentPermissions {
    pub fn full_account() -> Self {
        Self {
            notes_read: true,
            notes_write: true,
            comments_read: true,
            comments_write: true,
            tags_read: true,
        }
    }

    pub fn workspace_default() -> Self {
        Self {
            notes_read: true,
            notes_write: true,
            comments_read: true,
            comments_write: true,
            tags_read: true,
        }
    }

    pub fn default_json() -> Value {
        json!({
            "notes": ["read", "write"],
            "comments": ["read", "write"],
            "tags": ["read"]
        })
    }

    pub fn from_json(value: Value) -> Self {
        if !value.is_object() {
            return Self::workspace_default();
        }
        Self {
            notes_read: permission_allows(&value, "notes", "read"),
            notes_write: permission_allows(&value, "notes", "write"),
            comments_read: permission_allows(&value, "comments", "read"),
            comments_write: permission_allows(&value, "comments", "write"),
            tags_read: permission_allows(&value, "tags", "read"),
        }
    }

    pub fn allows_procedure(&self, path: &str) -> bool {
        match path {
            "notes.list"
            | "notes.listByIds"
            | "notes.detail"
            | "notes.noteReferenceList"
            | "notes.getNoteHistory"
            | "notes.getNoteVersion" => self.notes_read,
            "notes.upsert" | "notes.updateMany" | "notes.trashMany" => self.notes_write,
            "comments.list" => self.comments_read,
            "comments.create" | "comments.update" => self.comments_write,
            "tags.list" | "tags.fullTagNameById" => self.tags_read,
            _ => false,
        }
    }

    pub fn allows_mcp_tool(&self, tool_name: &str) -> bool {
        match tool_name {
            "searchBlinkora" | "getBlinkora" => self.notes_read,
            "upsertBlinkora" | "updateBlinkora" | "deleteBlinkora" => self.notes_write,
            "listComments" => self.comments_read,
            "createComment" | "updateComment" => self.comments_write,
            "listTagTree" => self.tags_read,
            _ => false,
        }
    }
}

#[async_trait]
impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_token(parts).ok_or_else(|| auth_error(parts, "Unauthorized"))?;
        if is_agent_token(&token) {
            return authenticate_agent_token(parts, state, &token)
                .await
                .map_err(|message| auth_error(parts, &message));
        }

        let claims = decode_jwt(&token, &state.config.auth_secret)
            .map_err(|_| auth_error(parts, "Invalid token"))?;
        let workspace_id = validate_workspace_header(parts, state.pool(), claims.id)
            .await
            .map_err(|message| auth_error(parts, &message))?;
        let mut user = CurrentUser::from_claims(claims);
        user.workspace_id = workspace_id;
        Ok(user)
    }
}

pub async fn optional_user(parts: &mut Parts, state: &AppState) -> Option<CurrentUser> {
    let token = extract_token(parts)?;
    if is_agent_token(&token) {
        return authenticate_agent_token(parts, state, &token).await.ok();
    }

    let claims = decode_jwt(&token, &state.config.auth_secret).ok()?;
    let workspace_id = validate_workspace_header(parts, state.pool(), claims.id)
        .await
        .ok()?;
    let mut user = CurrentUser::from_claims(claims);
    user.workspace_id = workspace_id;
    Some(user)
}

fn is_agent_token(token: &str) -> bool {
    token.starts_with("bkws_")
}

async fn authenticate_agent_token(
    parts: &Parts,
    state: &AppState,
    token: &str,
) -> Result<CurrentUser, String> {
    if !agent_endpoint_allowed(parts.uri.path()) {
        return Err("Agent token is not allowed for this endpoint".to_string());
    }

    let token_hash = hash_agent_token(token);
    let row = sqlx::query(
        r#"SELECT t.id, t."accountId", t."workspaceId", t.permissions, a.name, a.nickname, a.role
           FROM "agentAccessTokens" t
           JOIN accounts a ON a.id=t."accountId"
           JOIN workspaces w ON w.id=t."workspaceId" AND w."accountId"=t."accountId"
           WHERE t."tokenHash"=$1
             AND t."revokedAt" IS NULL
             AND (t."expiresAt" IS NULL OR t."expiresAt" > NOW())"#,
    )
    .bind(token_hash)
    .fetch_optional(state.pool())
    .await
    .map_err(|_| "Invalid token".to_string())?;

    let Some(row) = row else {
        return Err("Invalid token".to_string());
    };

    let workspace_id = row.get::<i32, _>("workspaceId");
    if let Some(header_workspace_id) = workspace_header(parts)? {
        if header_workspace_id != workspace_id {
            return Err("invalid workspace".to_string());
        }
    }

    let token_id = row.get::<i32, _>("id");
    let permissions = row
        .try_get::<Value, _>("permissions")
        .map(AgentPermissions::from_json)
        .unwrap_or_else(|_| AgentPermissions::workspace_default());

    sqlx::query(
        r#"UPDATE "agentAccessTokens" SET "lastUsedAt"=NOW(), "updatedAt"=NOW() WHERE id=$1"#,
    )
    .bind(token_id)
    .execute(state.pool())
    .await
    .map_err(|_| "Invalid token".to_string())?;

    Ok(CurrentUser {
        id: row.get::<i32, _>("accountId"),
        name: row.get::<String, _>("name"),
        nickname: row.get::<String, _>("nickname"),
        role: row.get::<String, _>("role"),
        sub: row.get::<i32, _>("accountId").to_string(),
        workspace_id: Some(workspace_id),
        auth_kind: AuthKind::WorkspaceAgent,
        agent_token_id: Some(token_id),
        agent_permissions: permissions,
    })
}

fn agent_endpoint_allowed(path: &str) -> bool {
    path.starts_with("/api/trpc/")
        || path.starts_with("/trpc/")
        || is_trpc_procedure_path(path)
        || path.starts_with("/api/agent/")
        || path.starts_with("/agent/")
        || path == "/mcp-guide.md"
        || path.starts_with("/blinkora-workspace/")
        || path == "/blinkora-workspace.zip"
        || path == "/api/sse"
        || path == "/api/messages"
        || path == "/sse"
        || path == "/messages"
}

fn is_trpc_procedure_path(path: &str) -> bool {
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return false;
    }
    path.split(',').all(|item| {
        item.contains('.')
            && item
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
    })
}

fn extract_token(parts: &Parts) -> Option<String> {
    if let Some(auth) = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.to_string());
        }
    }
    parts.uri.query().and_then(|query| {
        query.split('&').find_map(|part| {
            let (key, value) = part.split_once('=')?;
            (key == "token").then(|| value.to_string())
        })
    })
}

async fn validate_workspace_header(
    parts: &Parts,
    pool: &PgPool,
    user_id: i32,
) -> Result<Option<i32>, String> {
    let Some(workspace_id) = workspace_header(parts)? else {
        return Ok(None);
    };
    let exists: Option<i32> =
        sqlx::query_scalar(r#"SELECT id FROM workspaces WHERE id=$1 AND "accountId"=$2"#)
            .bind(workspace_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(|_| "invalid workspace".to_string())?;
    exists
        .map(|_| Some(workspace_id))
        .ok_or_else(|| "invalid workspace".to_string())
}

fn workspace_header(parts: &Parts) -> Result<Option<i32>, String> {
    let Some(value) = parts
        .headers
        .get("x-workspace-id")
        .and_then(|v| v.to_str().ok())
    else {
        return Ok(None);
    };
    value
        .parse()
        .map(Some)
        .map_err(|_| "invalid workspace".to_string())
}

fn permission_allows(value: &Value, resource: &str, action: &str) -> bool {
    match value.get(resource) {
        Some(Value::Array(items)) => items.iter().any(|item| item.as_str() == Some(action)),
        Some(Value::Object(map)) => map.get(action).and_then(Value::as_bool).unwrap_or(false),
        _ => false,
    }
}

fn auth_error(parts: &Parts, message: &str) -> Response {
    if parts.uri.path().starts_with("/api/trpc/") {
        let path = parts.uri.path().trim_start_matches("/api/trpc/");
        let body = if parts.uri.query().unwrap_or("").contains("batch=1") {
            let items: Vec<_> = path
                .split(',')
                .map(|batch_path| trpc_auth_error(message, batch_path))
                .collect();
            json!(items)
        } else {
            trpc_auth_error(message, path)
        };
        return (StatusCode::UNAUTHORIZED, axum::Json(body)).into_response();
    }
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(json!({ "error": message })),
    )
        .into_response()
}

fn trpc_auth_error(message: &str, path: &str) -> serde_json::Value {
    json!({
        "error": {
            "json": {
                "message": message,
                "code": -32001,
                "data": {
                    "code": "UNAUTHORIZED",
                    "httpStatus": 401,
                    "path": path
                }
            }
        }
    })
}

pub fn generate_agent_token() -> String {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    format!("bkws_{}", URL_SAFE_NO_PAD.encode(raw))
}

pub fn hash_agent_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn generate_jwt(
    id: i32,
    name: &str,
    nickname: &str,
    role: &str,
    secret: &str,
) -> anyhow::Result<String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as usize;
    let claims = Claims {
        id,
        name: name.to_string(),
        nickname: nickname.to_string(),
        role: role.to_string(),
        sub: id.to_string(),
        iat: now,
        exp: now + 30 * 24 * 60 * 60,
    };
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?)
}

pub fn decode_jwt(token: &str, secret: &str) -> anyhow::Result<Claims> {
    Ok(decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )?
    .claims)
}

pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let salt_string = hex::encode(salt);
    let mut output = [0u8; 64];
    pbkdf2_hmac::<Sha512>(
        password.as_bytes(),
        salt_string.as_bytes(),
        1000,
        &mut output,
    );
    format!("pbkdf2:{}:{}", salt_string, hex::encode(output))
}

pub fn verify_password(input_password: &str, hashed_password: &str) -> bool {
    let parts: Vec<&str> = hashed_password.splitn(3, ':').collect();
    if parts.len() != 3 || parts[0] != "pbkdf2" {
        return false;
    }
    let Ok(expected) = hex::decode(parts[2]) else {
        return false;
    };
    let mut output = [0u8; 64];
    pbkdf2_hmac::<Sha512>(
        input_password.as_bytes(),
        parts[1].as_bytes(),
        1000,
        &mut output,
    );
    constant_time_eq(&output, &expected)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in a.iter().zip(b.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

pub fn generate_totp_secret() -> String {
    let mut raw = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut raw);
    base32::encode(base32::Alphabet::Rfc4648 { padding: false }, &raw)
}

pub fn verify_totp(secret: &str, token: &str, now: i64) -> bool {
    let token = token.trim();
    if token.len() != 6 {
        return false;
    }
    let Some(secret_bytes) = base32::decode(
        base32::Alphabet::Rfc4648 { padding: false },
        &secret.to_uppercase(),
    ) else {
        return false;
    };
    let counter = now / 30;
    for offset in -1..=1 {
        if totp_code(&secret_bytes, (counter + offset) as u64) == token {
            return true;
        }
    }
    false
}

fn totp_code(secret: &[u8], counter: u64) -> String {
    type HmacSha1 = Hmac<Sha1>;
    let mut mac = HmacSha1::new_from_slice(secret).expect("hmac accepts any key");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let code = ((u32::from(digest[offset]) & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    format!("{:06}", code % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::{
        agent_endpoint_allowed, generate_agent_token, hash_agent_token, hash_password,
        verify_password, AgentPermissions,
    };

    #[test]
    fn verifies_node_compatible_pbkdf2() {
        let hash = hash_password("secret");
        assert!(verify_password("secret", &hash));
        assert!(!verify_password("wrong", &hash));
    }

    #[test]
    fn generates_workspace_agent_token_prefix_and_sha256_hash() {
        let token = generate_agent_token();
        assert!(token.starts_with("bkws_"));
        assert_eq!(hash_agent_token("bkws_test").len(), 64);
        assert_eq!(hash_agent_token("bkws_test"), hash_agent_token("bkws_test"));
    }

    #[test]
    fn workspace_agent_permissions_whitelist_expected_procedures() {
        let permissions = AgentPermissions::workspace_default();
        assert!(permissions.allows_procedure("notes.list"));
        assert!(permissions.allows_procedure("comments.create"));
        assert!(permissions.allows_procedure("tags.list"));
        assert!(!permissions.allows_procedure("workspaces.list"));
        assert!(!permissions.allows_procedure("config.list"));
        assert!(!permissions.allows_procedure("notes.deleteMany"));
    }

    #[test]
    fn workspace_agent_auth_allows_nested_trpc_route_paths() {
        assert!(agent_endpoint_allowed("/api/trpc/notes.list"));
        assert!(agent_endpoint_allowed("/trpc/notes.list"));
        assert!(agent_endpoint_allowed("/notes.list"));
        assert!(agent_endpoint_allowed("/workspaces.list"));
        assert!(!agent_endpoint_allowed("/api/backup/export"));
    }
}
