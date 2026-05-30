use crate::app::AppState;
use async_trait::async_trait;
use axum::extract::FromRequestParts;
use axum::http::{request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha1::Sha1;
use sha2::Sha512;
use sqlx::PgPool;
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
        }
    }
}

#[async_trait]
impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = extract_token(parts).ok_or_else(|| auth_error(parts, "Unauthorized"))?;
        let claims = decode_jwt(&token, &state.config.jwt_secret)
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
    let claims = decode_jwt(&token, &state.config.jwt_secret).ok()?;
    let workspace_id = validate_workspace_header(parts, state.pool(), claims.id).await.ok()?;
    let mut user = CurrentUser::from_claims(claims);
    user.workspace_id = workspace_id;
    Some(user)
}

fn extract_token(parts: &Parts) -> Option<String> {
    if let Some(auth) = parts.headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.to_string());
        }
    }
    if let Some(cookie) = parts.headers.get("cookie").and_then(|v| v.to_str().ok()) {
        for item in cookie.split(';') {
            let item = item.trim();
            if let Some(token) = item.strip_prefix("next-auth.session-token=") {
                return Some(token.to_string());
            }
            if let Some(token) = item.strip_prefix("__Secure-next-auth.session-token=") {
                return Some(token.to_string());
            }
        }
    }
    parts
        .uri
        .query()
        .and_then(|query| {
            query.split('&').find_map(|part| {
                let (key, value) = part.split_once('=')?;
                (key == "token").then(|| value.to_string())
            })
        })
}

async fn validate_workspace_header(parts: &Parts, pool: &PgPool, user_id: i32) -> Result<Option<i32>, String> {
    let Some(value) = parts.headers.get("x-workspace-id").and_then(|v| v.to_str().ok()) else {
        return Ok(None);
    };
    let workspace_id: i32 = value.parse().map_err(|_| "invalid workspace".to_string())?;
    let exists: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM workspaces WHERE id=$1 AND "accountId"=$2"#)
        .bind(workspace_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| "invalid workspace".to_string())?;
    exists.map(|_| Some(workspace_id)).ok_or_else(|| "invalid workspace".to_string())
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

pub fn generate_jwt(id: i32, name: &str, nickname: &str, role: &str, secret: &str) -> anyhow::Result<String> {
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
    Ok(encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(secret.as_bytes()))?)
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
    pbkdf2_hmac::<Sha512>(password.as_bytes(), salt_string.as_bytes(), 1000, &mut output);
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
    pbkdf2_hmac::<Sha512>(input_password.as_bytes(), parts[1].as_bytes(), 1000, &mut output);
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
    let Some(secret_bytes) = base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &secret.to_uppercase()) else {
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
    use super::{hash_password, verify_password};

    #[test]
    fn verifies_node_compatible_pbkdf2() {
        let hash = hash_password("secret");
        assert!(verify_password("secret", &hash));
        assert!(!verify_password("wrong", &hash));
    }
}
