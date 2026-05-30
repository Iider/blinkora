use crate::app::AppState;
use crate::auth::{generate_jwt, generate_totp_secret, hash_password, verify_password, verify_totp, CurrentUser};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use crate::util::config_json;
use anyhow::{anyhow, bail};
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use futures::FutureExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login", post(login))
        .route("/register", post(register_rest))
        .route("/logout", post(logout))
        .route("/profile", get(profile))
        .route("/verify-2fa", post(verify_2fa_rest))
        .route("/validate-token", get(validate_token))
}

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("users.detail", user_detail);
    registry.insert("users.canRegister", can_register);
    registry.insert("users.register", register_user);
    registry.insert("users.login", login_user);
    registry.insert("users.regenToken", regen_token);
    registry.insert("users.upsertUser", upsert_user);
    registry.insert("users.generate2FASecret", generate_2fa_secret);
    registry.insert("users.verify2FAToken", verify_2fa_token);
    registry.insert("users.nativeAccountList", native_account_list);
    registry.insert("users.linkAccount", link_account);
}

#[derive(Deserialize)]
struct LoginRequest {
    name: Option<String>,
    username: Option<String>,
    password: String,
}

async fn login(State(state): State<AppState>, Json(req): Json<LoginRequest>) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let username = req.name.or(req.username).unwrap_or_default();
    let row = sqlx::query(r#"SELECT id, name, nickname, password, image, role FROM accounts WHERE name=$1"#)
        .bind(username)
        .fetch_one(state.pool())
        .await
        .map_err(|_| unauthorized())?;
    let password_hash: String = row.get("password");
    if !verify_password(&req.password, &password_hash) {
        return Err(unauthorized());
    }
    let id: i32 = row.get("id");
    let name: String = row.get("name");
    let nickname: String = row.get("nickname");
    let image: String = row.get("image");
    let role: String = row.get("role");
    let token = generate_jwt(id, &name, &nickname, &role, &state.config.jwt_secret).map_err(|_| unauthorized())?;
    Ok(Json(json!({
        "user": { "id": id, "name": name, "nickname": nickname, "image": image, "role": role },
        "token": token
    })))
}

fn unauthorized() -> (axum::http::StatusCode, Json<Value>) {
    (
        axum::http::StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Invalid username or password" })),
    )
}

#[derive(Deserialize)]
struct RegisterRequest {
    name: String,
    password: String,
    nickname: Option<String>,
}

async fn register_rest(State(state): State<AppState>, Json(req): Json<RegisterRequest>) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match create_account_with_default_workspace(state.pool(), &state.config.jwt_secret, &req.name, &req.password, req.nickname.as_deref()).await {
        Ok((id, token)) => Ok(Json(json!({ "success": true, "token": token, "id": id }))),
        Err(err) => Err((axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": err.to_string() })))),
    }
}

async fn logout() -> Json<Value> {
    Json(json!({ "success": true }))
}

async fn profile(user: CurrentUser, State(state): State<AppState>) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let row = sqlx::query(r#"SELECT id, name, nickname, "apiToken", image, role FROM accounts WHERE id=$1"#)
        .bind(user.id)
        .fetch_one(state.pool())
        .await
        .map_err(|_| (axum::http::StatusCode::NOT_FOUND, Json(json!({ "error": "User not found" }))))?;
    Ok(Json(json!({
        "user": {
            "id": row.get::<i32, _>("id"),
            "name": row.get::<String, _>("name"),
            "nickName": row.get::<String, _>("nickname"),
            "token": row.get::<String, _>("apiToken"),
            "image": row.get::<String, _>("image"),
            "role": row.get::<String, _>("role")
        }
    })))
}

async fn verify_2fa_rest() -> Json<Value> {
    Json(json!({ "success": true }))
}

async fn validate_token(user: CurrentUser) -> Json<Value> {
    Json(json!({
        "valid": true,
        "user": {
            "id": user.id,
            "name": user.name,
            "nickname": user.nickname,
            "role": user.role,
            "sub": user.sub
        }
    }))
}

fn user_detail(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.ok_or_else(|| anyhow!("Unauthorized"))?;
        let row = sqlx::query(r#"SELECT id, name, COALESCE(nickname,'') AS nickname, COALESCE("apiToken",'') AS token, COALESCE(image,'') AS image, COALESCE(role,'') AS role FROM accounts WHERE id=$1"#)
            .bind(user.id)
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(json!({
            "id": row.get::<i32, _>("id"),
            "name": row.get::<String, _>("name"),
            "nickName": row.get::<String, _>("nickname"),
            "token": row.get::<String, _>("token"),
            "image": row.get::<String, _>("image"),
            "role": row.get::<String, _>("role")
        }))
    }
    .boxed()
}

fn can_register(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts").fetch_one(ctx.state.pool()).await?;
        Ok(json!(count == 0))
    }
    .boxed()
}

fn register_user(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let req: RegisterRequest = serde_json::from_value(input)?;
        create_account_with_default_workspace(ctx.state.pool(), &ctx.state.config.jwt_secret, &req.name, &req.password, req.nickname.as_deref()).await?;
        Ok(json!(true))
    }
    .boxed()
}

fn login_user(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let req: LoginRequest = serde_json::from_value(input)?;
        let username = req.name.or(req.username).unwrap_or_default();
        let row = sqlx::query(r#"SELECT id, name, nickname, password, image, role FROM accounts WHERE name=$1"#)
            .bind(username)
            .fetch_one(ctx.state.pool())
            .await
            .map_err(|_| anyhow!("user not found"))?;
        let password_hash: String = row.get("password");
        if !verify_password(&req.password, &password_hash) {
            bail!("password is incorrect");
        }
        let id: i32 = row.get("id");
        let name: String = row.get("name");
        let nickname: String = row.get("nickname");
        let image: String = row.get("image");
        let role: String = row.get("role");
        let token = generate_jwt(id, &name, &nickname, &role, &ctx.state.config.jwt_secret)?;
        sqlx::query(r#"UPDATE accounts SET "apiToken"=$1, "updatedAt"=NOW() WHERE id=$2"#)
            .bind(&token)
            .bind(id)
            .execute(ctx.state.pool())
            .await?;
        Ok(json!({
            "id": id,
            "name": name,
            "nickname": nickname,
            "role": role,
            "token": token,
            "image": image
        }))
    }
    .boxed()
}

fn regen_token(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.ok_or_else(|| anyhow!("Unauthorized"))?;
        let row = sqlx::query("SELECT name, COALESCE(nickname,'') AS nickname, COALESCE(role,'') AS role FROM accounts WHERE id=$1")
            .bind(user.id)
            .fetch_one(ctx.state.pool())
            .await?;
        let token = generate_jwt(
            user.id,
            &row.get::<String, _>("name"),
            &row.get::<String, _>("nickname"),
            &row.get::<String, _>("role"),
            &ctx.state.config.jwt_secret,
        )?;
        sqlx::query(r#"UPDATE accounts SET "apiToken"=$1, "updatedAt"=NOW() WHERE id=$2"#)
            .bind(token)
            .bind(user.id)
            .execute(ctx.state.pool())
            .await?;
        Ok(json!(true))
    }
    .boxed()
}

fn upsert_user(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.ok_or_else(|| anyhow!("Unauthorized"))?;
        let name = input.get("name").and_then(Value::as_str).unwrap_or("");
        let nickname = input.get("nickname").and_then(Value::as_str).unwrap_or("");
        let image = input.get("image").and_then(Value::as_str).unwrap_or("");
        let password = input.get("password").and_then(Value::as_str).unwrap_or("");
        let original = input.get("originalPassword").and_then(Value::as_str).unwrap_or("");
        let row = sqlx::query("SELECT name, password FROM accounts WHERE id=$1")
            .bind(user.id)
            .fetch_one(ctx.state.pool())
            .await?;
        let mut new_hash = String::new();
        if !password.is_empty() {
            if original.is_empty() || !verify_password(original, &row.get::<String, _>("password")) {
                bail!("original password is incorrect");
            }
            new_hash = hash_password(password);
        }
        sqlx::query(
            r#"UPDATE accounts SET
            name=COALESCE(NULLIF($1,''), name),
            nickname=COALESCE(NULLIF($2,''), nickname),
            image=COALESCE(NULLIF($3,''), image),
            password=COALESCE(NULLIF($4,''), password),
            "updatedAt"=NOW()
            WHERE id=$5"#,
        )
        .bind(name)
        .bind(nickname)
        .bind(image)
        .bind(new_hash)
        .bind(user.id)
        .execute(ctx.state.pool())
        .await?;
        Ok(json!(true))
    }
    .boxed()
}

fn generate_2fa_secret(_ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let name = input.get("name").and_then(Value::as_str).unwrap_or("");
        let secret = generate_totp_secret();
        let label_text = format!("Blinkora:{name}");
        let label = urlencoding::encode(&label_text);
        Ok(json!({ "secret": secret, "qrCode": format!("otpauth://totp/{label}?secret={secret}&issuer=Blinkora") }))
    }
    .boxed()
}

fn verify_2fa_token(_ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let token = input.get("token").and_then(Value::as_str).unwrap_or("");
        let secret = input.get("secret").and_then(Value::as_str).unwrap_or("");
        if !verify_totp(secret, token, Utc::now().timestamp()) {
            bail!("invalid verification code");
        }
        Ok(json!(true))
    }
    .boxed()
}

fn native_account_list(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.ok_or_else(|| anyhow!("Unauthorized"))?;
        let rows = sqlx::query("SELECT id, name, COALESCE(nickname,'') AS nickname FROM accounts WHERE id<>$1 ORDER BY id ASC")
            .bind(user.id)
            .fetch_all(ctx.state.pool())
            .await?;
        Ok(Value::Array(rows.into_iter().map(|row| json!({
            "id": row.get::<i32, _>("id"),
            "name": row.get::<String, _>("name"),
            "nickname": row.get::<String, _>("nickname")
        })).collect()))
    }
    .boxed()
}

fn link_account(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let password = input.get("originalPassword").and_then(Value::as_str).unwrap_or("");
        let hash: String = sqlx::query_scalar("SELECT password FROM accounts WHERE id=$1")
            .bind(id)
            .fetch_one(ctx.state.pool())
            .await
            .map_err(|_| anyhow!("account not found"))?;
        if !verify_password(password, &hash) {
            bail!("password is incorrect");
        }
        Ok(json!(true))
    }
    .boxed()
}

async fn create_account_with_default_workspace(pool: &PgPool, secret: &str, name: &str, password: &str, nickname: Option<&str>) -> anyhow::Result<(i32, String)> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts").fetch_one(pool).await?;
    if count > 0 {
        bail!("registration is closed for single-account mode");
    }
    let nickname = nickname.filter(|v| !v.is_empty()).unwrap_or(name);
    let mut tx = pool.begin().await?;
    let password_hash = hash_password(password);
    let user_id: i32 = sqlx::query_scalar(r#"INSERT INTO accounts (name, password, nickname, role, "updatedAt") VALUES ($1,$2,$3,$4,NOW()) RETURNING id"#)
        .bind(name)
        .bind(password_hash)
        .bind(nickname)
        .bind("superadmin")
        .fetch_one(&mut *tx)
        .await?;
    let token = generate_jwt(user_id, name, nickname, "superadmin", secret)?;
    sqlx::query(r#"UPDATE accounts SET "apiToken"=$1 WHERE id=$2"#)
        .bind(&token)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    let workspace_id: i32 = sqlx::query_scalar(r#"INSERT INTO workspaces (name, "accountId", "isDefault", "updatedAt") VALUES ($1,$2,true,NOW()) RETURNING id"#)
        .bind("默认工作区")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
    for (key, value) in [("theme", json!("system")), ("language", json!("zh"))] {
        sqlx::query(r#"INSERT INTO config (key, config, "userId", "workspaceId") VALUES ($1,$2,$3,$4)"#)
            .bind(key)
            .bind(config_json(value))
            .bind(user_id)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok((user_id, token))
}
