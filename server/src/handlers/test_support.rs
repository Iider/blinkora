use crate::{
    app::AppState,
    auth::{AgentPermissions, AuthKind, CurrentUser},
    config::Config,
    trpc::ProcedureContext,
};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

pub(crate) struct HandlerTestFixture {
    pub data_dir: PathBuf,
    pub pool: SqlitePool,
    pub ctx: ProcedureContext,
    pub account_id: i32,
    pub workspace_id: i32,
}

impl HandlerTestFixture {
    pub async fn new(label: &str) -> Self {
        let data_dir =
            std::env::temp_dir().join(format!("blinkora-handler-{label}-{}", uuid::Uuid::new_v4()));
        let pool = crate::db::connect(&data_dir)
            .await
            .expect("open handler test database");
        crate::db::init_schema(
            &pool,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../db/schema.sqlite.sql"),
        )
        .await
        .expect("initialize handler test schema");
        let account_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO accounts (name, password, nickname, role, "updatedAt")
               VALUES ('owner', 'hash', 'Owner', 'superadmin', blinkora_now()) RETURNING id"#,
        )
        .fetch_one(&pool)
        .await
        .expect("seed handler test account");
        let workspace_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO workspaces (name, "accountId", "isDefault")
               VALUES ('main', $1, true) RETURNING id"#,
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await
        .expect("seed handler test workspace");
        let state = AppState::new(
            Config {
                port: "0".into(),
                auth_secret: "test-secret".into(),
                node_env: "test".into(),
                public_path: "./public".into(),
                data_dir: data_dir.display().to_string(),
                schema_path: "db/schema.sqlite.sql".into(),
            },
            pool.clone(),
        );
        let ctx = ProcedureContext {
            state,
            user: Some(CurrentUser {
                id: account_id,
                name: "owner".into(),
                nickname: "Owner".into(),
                role: "superadmin".into(),
                sub: account_id.to_string(),
                workspace_id: Some(workspace_id),
                auth_kind: AuthKind::Account,
                agent_token_id: None,
                agent_permissions: AgentPermissions::full_account(),
            }),
        };
        Self {
            data_dir,
            pool,
            ctx,
            account_id,
            workspace_id,
        }
    }

    pub async fn create_workspace(&self, name: &str) -> i32 {
        sqlx::query_scalar(
            r#"INSERT INTO workspaces (name, "accountId", "isDefault")
               VALUES ($1, $2, false) RETURNING id"#,
        )
        .bind(name)
        .bind(self.account_id)
        .fetch_one(&self.pool)
        .await
        .expect("seed additional workspace")
    }

    pub async fn cleanup(self) {
        drop(self.ctx);
        self.pool.close().await;
        tokio::fs::remove_dir_all(self.data_dir)
            .await
            .expect("remove handler test database");
    }
}
