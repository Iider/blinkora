use crate::app::AppState;
use crate::auth::{
    generate_jwt, generate_totp_secret, hash_password, verify_password, verify_totp, CurrentUser,
};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use crate::util::{config_json, unwrap_config_value};
use anyhow::{anyhow, bail};
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use futures::FutureExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};
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

#[derive(Deserialize)]
struct VerifyTwoFactorRequest {
    #[serde(rename = "userId")]
    user_id: i32,
    code: String,
}

struct LoginAccount {
    id: i32,
    name: String,
    nickname: String,
    password: String,
    image: String,
    role: String,
}

enum TwoFactorState {
    Disabled,
    Enabled { secret: String },
    Misconfigured,
}

async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let username = req.name.or(req.username).unwrap_or_default();
    let account = find_account_by_name(state.pool(), &username)
        .await
        .map_err(|_| unauthorized())?;
    if !verify_password(&req.password, &account.password) {
        return Err(unauthorized());
    }

    match two_factor_state(state.pool(), account.id)
        .await
        .map_err(|_| unauthorized())?
    {
        TwoFactorState::Enabled { .. } => {
            return Ok(Json(json!({
                "requiresTwoFactor": true,
                "userId": account.id,
            })));
        }
        TwoFactorState::Misconfigured => return Err(two_factor_unavailable()),
        TwoFactorState::Disabled => {}
    }

    let token = generate_jwt(
        account.id,
        &account.name,
        &account.nickname,
        &account.role,
        &state.config.auth_secret,
    )
    .map_err(|_| unauthorized())?;
    Ok(Json(json!({
        "user": {
            "id": account.id,
            "name": account.name,
            "nickname": account.nickname,
            "image": account.image,
            "role": account.role,
        },
        "token": token
    })))
}

fn unauthorized() -> (axum::http::StatusCode, Json<Value>) {
    (
        axum::http::StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Invalid username or password" })),
    )
}

fn two_factor_unavailable() -> (axum::http::StatusCode, Json<Value>) {
    (
        axum::http::StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Two-factor authentication is not configured" })),
    )
}

fn invalid_two_factor_code() -> (axum::http::StatusCode, Json<Value>) {
    (
        axum::http::StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Invalid verification code" })),
    )
}

#[derive(Deserialize)]
struct RegisterRequest {
    name: String,
    password: String,
    nickname: Option<String>,
}

async fn register_rest(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let _write_guard = state.write_guard().await;
    match create_account_with_default_workspace(
        state.pool(),
        &state.config.auth_secret,
        &req.name,
        &req.password,
        req.nickname.as_deref(),
    )
    .await
    {
        Ok((id, token)) => Ok(Json(json!({ "success": true, "token": token, "id": id }))),
        Err(err) => Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": err.to_string() })),
        )),
    }
}

async fn logout() -> Json<Value> {
    Json(json!({ "success": true }))
}

async fn profile(
    user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let row = sqlx::query(
        r#"SELECT id, name, nickname, "apiToken", image, role FROM accounts WHERE id=$1"#,
    )
    .bind(user.id)
    .fetch_one(state.pool())
    .await
    .map_err(|_| {
        (
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({ "error": "User not found" })),
        )
    })?;
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

async fn verify_2fa_rest(
    State(state): State<AppState>,
    Json(req): Json<VerifyTwoFactorRequest>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let account = find_account_by_id(state.pool(), req.user_id)
        .await
        .map_err(|_| invalid_two_factor_code())?;
    let secret = match two_factor_state(state.pool(), account.id)
        .await
        .map_err(|_| invalid_two_factor_code())?
    {
        TwoFactorState::Enabled { secret } => secret,
        TwoFactorState::Disabled | TwoFactorState::Misconfigured => {
            return Err(invalid_two_factor_code());
        }
    };
    if !verify_totp(&secret, &req.code, Utc::now().timestamp()) {
        return Err(invalid_two_factor_code());
    }

    let token = generate_jwt(
        account.id,
        &account.name,
        &account.nickname,
        &account.role,
        &state.config.auth_secret,
    )
    .map_err(|_| invalid_two_factor_code())?;
    let _write_guard = state.write_guard().await;
    sqlx::query(r#"UPDATE accounts SET "apiToken"=$1, "updatedAt"=blinkora_now() WHERE id=$2"#)
        .bind(&token)
        .bind(account.id)
        .execute(state.pool())
        .await
        .map_err(|_| invalid_two_factor_code())?;

    Ok(Json(json!({
        "user": {
            "id": account.id,
            "name": account.name,
            "nickname": account.nickname,
            "image": account.image,
            "role": account.role,
        },
        "token": token,
    })))
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
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(json!(count == 0))
    }
    .boxed()
}

fn register_user(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let req: RegisterRequest = serde_json::from_value(input)?;
        create_account_with_default_workspace(
            ctx.state.pool(),
            &ctx.state.config.auth_secret,
            &req.name,
            &req.password,
            req.nickname.as_deref(),
        )
        .await?;
        Ok(json!(true))
    }
    .boxed()
}

fn login_user(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let req: LoginRequest = serde_json::from_value(input)?;
        let username = req.name.or(req.username).unwrap_or_default();
        let account = find_account_by_name(ctx.state.pool(), &username)
            .await
            .map_err(|_| anyhow!("user not found"))?;
        if !verify_password(&req.password, &account.password) {
            bail!("password is incorrect");
        }

        match two_factor_state(ctx.state.pool(), account.id).await? {
            TwoFactorState::Enabled { .. } => {
                return Ok(json!({
                    "requiresTwoFactor": true,
                    "userId": account.id,
                }));
            }
            TwoFactorState::Misconfigured => bail!("two-factor authentication is not configured"),
            TwoFactorState::Disabled => {}
        }

        let token = generate_jwt(
            account.id,
            &account.name,
            &account.nickname,
            &account.role,
            &ctx.state.config.auth_secret,
        )?;
        sqlx::query(r#"UPDATE accounts SET "apiToken"=$1, "updatedAt"=blinkora_now() WHERE id=$2"#)
            .bind(&token)
            .bind(account.id)
            .execute(ctx.state.pool())
            .await?;
        Ok(json!({
            "id": account.id,
            "name": account.name,
            "nickname": account.nickname,
            "role": account.role,
            "token": token,
            "image": account.image
        }))
    }
    .boxed()
}

fn login_account_from_row(row: &SqliteRow) -> LoginAccount {
    LoginAccount {
        id: row.get("id"),
        name: row.get("name"),
        nickname: row.get("nickname"),
        password: row.get("password"),
        image: row.get("image"),
        role: row.get("role"),
    }
}

async fn find_account_by_name(pool: &SqlitePool, name: &str) -> anyhow::Result<LoginAccount> {
    let row = sqlx::query(
        r#"SELECT id, name, nickname, password, image, role FROM accounts WHERE name=$1"#,
    )
    .bind(name)
    .fetch_one(pool)
    .await?;
    Ok(login_account_from_row(&row))
}

async fn find_account_by_id(pool: &SqlitePool, id: i32) -> anyhow::Result<LoginAccount> {
    let row = sqlx::query(
        r#"SELECT id, name, nickname, password, image, role FROM accounts WHERE id=$1"#,
    )
    .bind(id)
    .fetch_one(pool)
    .await?;
    Ok(login_account_from_row(&row))
}

async fn two_factor_state(pool: &SqlitePool, user_id: i32) -> anyhow::Result<TwoFactorState> {
    let rows = sqlx::query(
        r#"SELECT key, config
           FROM config
           WHERE key IN ('twoFactorEnabled', 'twoFactorSecret')
             AND "userId"=$1
           ORDER BY CASE WHEN "workspaceId" IS NULL THEN 0 ELSE 1 END, id DESC"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut enabled = None;
    let mut secret = None;
    for row in rows {
        let key: String = row.get("key");
        let value = unwrap_config_value(row.get::<Option<Value>, _>("config"));
        match key.as_str() {
            "twoFactorEnabled" if enabled.is_none() => enabled = value.as_bool(),
            "twoFactorSecret" if secret.is_none() => {
                secret = value
                    .as_str()
                    .map(str::to_owned)
                    .filter(|value| !value.is_empty());
            }
            _ => {}
        }
    }

    match enabled {
        Some(true) if secret.is_some() => Ok(TwoFactorState::Enabled {
            secret: secret.expect("checked above"),
        }),
        Some(true) => Ok(TwoFactorState::Misconfigured),
        _ => Ok(TwoFactorState::Disabled),
    }
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
            &ctx.state.config.auth_secret,
        )?;
        sqlx::query(r#"UPDATE accounts SET "apiToken"=$1, "updatedAt"=blinkora_now() WHERE id=$2"#)
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
        let original = input
            .get("originalPassword")
            .and_then(Value::as_str)
            .unwrap_or("");
        let row = sqlx::query("SELECT name, password FROM accounts WHERE id=$1")
            .bind(user.id)
            .fetch_one(ctx.state.pool())
            .await?;
        let mut new_hash = String::new();
        if !password.is_empty() {
            if original.is_empty() || !verify_password(original, &row.get::<String, _>("password"))
            {
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
            "updatedAt"=blinkora_now()
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
        let password = input
            .get("originalPassword")
            .and_then(Value::as_str)
            .unwrap_or("");
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

async fn create_account_with_default_workspace(
    pool: &SqlitePool,
    secret: &str,
    name: &str,
    password: &str,
    nickname: Option<&str>,
) -> anyhow::Result<(i32, String)> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
        .fetch_one(pool)
        .await?;
    if count > 0 {
        bail!("registration is closed for single-account mode");
    }
    let nickname = nickname.filter(|v| !v.is_empty()).unwrap_or(name);
    let mut tx = pool.begin().await?;
    let password_hash = hash_password(password);
    let user_id: i32 = sqlx::query_scalar(r#"INSERT INTO accounts (name, password, nickname, role, "updatedAt") VALUES ($1,$2,$3,$4,blinkora_now()) RETURNING id"#)
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
    let workspace_id: i32 = sqlx::query_scalar(r#"INSERT INTO workspaces (name, "accountId", "isDefault", "updatedAt") VALUES ($1,$2,true,blinkora_now()) RETURNING id"#)
        .bind("默认工作区")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
    for (key, value) in [("theme", json!("system")), ("language", json!("zh"))] {
        sqlx::query(
            r#"INSERT INTO config (key, config, "userId", "workspaceId") VALUES ($1,$2,$3,$4)"#,
        )
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

#[cfg(test)]
mod tests {
    use super::{two_factor_state, TwoFactorState};
    use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

    async fn two_factor_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory SQLite database");
        sqlx::query(
            r#"CREATE TABLE config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL,
                config TEXT,
                "userId" INTEGER,
                "workspaceId" INTEGER
            )"#,
        )
        .execute(&pool)
        .await
        .expect("create config table");
        pool
    }

    #[tokio::test]
    async fn two_factor_state_requires_a_verified_secret() {
        let pool = two_factor_test_pool().await;
        assert!(matches!(
            two_factor_state(&pool, 7).await.unwrap(),
            TwoFactorState::Disabled
        ));

        sqlx::query(
            r#"INSERT INTO config (key, config, "userId", "workspaceId")
               VALUES ('twoFactorEnabled', '{"value":true}', 7, 1)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(matches!(
            two_factor_state(&pool, 7).await.unwrap(),
            TwoFactorState::Misconfigured
        ));

        sqlx::query(
            r#"INSERT INTO config (key, config, "userId", "workspaceId")
               VALUES ('twoFactorSecret', '{"value":"JBSWY3DPEHPK3PXP"}', 7, 1)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        match two_factor_state(&pool, 7).await.unwrap() {
            TwoFactorState::Enabled { secret } => assert_eq!(secret, "JBSWY3DPEHPK3PXP"),
            TwoFactorState::Disabled | TwoFactorState::Misconfigured => {
                panic!("enabled two-factor configuration was not recognized")
            }
        }

        sqlx::query(
            r#"INSERT INTO config (key, config, "userId", "workspaceId")
               VALUES ('twoFactorEnabled', '{"value":false}', 7, 2)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO config (key, config, "userId")
               VALUES ('twoFactorSecret', '{"value":"ACCOUNTSECRET"}', 7)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO config (key, config, "userId")
               VALUES ('twoFactorEnabled', '{"value":true}', 7)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        match two_factor_state(&pool, 7).await.unwrap() {
            TwoFactorState::Enabled { secret } => assert_eq!(secret, "ACCOUNTSECRET"),
            TwoFactorState::Disabled | TwoFactorState::Misconfigured => {
                panic!(
                    "account-level two-factor configuration must override legacy workspace values"
                )
            }
        }

        pool.close().await;
    }
}
