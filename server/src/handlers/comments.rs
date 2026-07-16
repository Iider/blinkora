use super::common::{account_brief, workspace_id};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::{Row, Sqlite, Transaction};
use std::collections::HashMap;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("comments.list", list);
    registry.insert("comments.create", create);
    registry.insert("comments.update", update);
    registry.insert("comments.delete", delete);
    registry.insert("comments.convertToTodo", convert_to_todo);
}

fn list(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let note_id = input
            .get("noteId")
            .and_then(Value::as_i64)
            .unwrap_or_default() as i32;
        let exists: Option<i32> = sqlx::query_scalar(
            r#"SELECT id FROM notes WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#,
        )
        .bind(note_id)
        .bind(user.id)
        .bind(ws)
        .fetch_optional(ctx.state.pool())
        .await?;
        if exists.is_none() {
            bail!("note not found");
        }
        let rows = sqlx::query(&comment_select_sql(
            r#""noteId"=$1 AND "parentId" IS NULL ORDER BY "createdAt" ASC, id ASC"#,
        ))
        .bind(note_id)
        .fetch_all(ctx.state.pool())
        .await?;
        let mut items = Vec::new();
        for row in rows {
            items.push(comment_json(&ctx, row, true).await?);
        }
        Ok(Value::Array(items))
    }
    .boxed()
}

fn create(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let note_id = input.get("noteId").and_then(Value::as_i64).unwrap_or_default() as i32;
        let content = input.get("content").and_then(Value::as_str).unwrap_or("");
        let kind = input.get("kind").and_then(Value::as_str).unwrap_or("annotation");
        let parent_id = input.get("parentId").and_then(Value::as_i64).map(|v| v as i32);
        let metadata = input.get("metadata").cloned();
        let exists: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM notes WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(note_id)
            .bind(user.id)
            .bind(ws)
            .fetch_optional(ctx.state.pool())
            .await?;
        if exists.is_none() {
            bail!("note not found");
        }
        if let Some(parent_id) = parent_id {
            let parent_note: Option<i32> = sqlx::query_scalar(r#"SELECT "noteId" FROM comments WHERE id=$1"#)
                .bind(parent_id)
                .fetch_optional(ctx.state.pool())
                .await?;
            if parent_note != Some(note_id) {
                bail!("reply parent must belong to the same note");
            }
        }
        let row = sqlx::query(
            r#"INSERT INTO comments (content, kind, status, metadata, "accountId", "noteId", "workspaceId", "parentId", "updatedAt")
               VALUES ($1,$2,'open',$3,$4,$5,$6,$7,blinkora_now())
               RETURNING id, content, kind, status, metadata, "accountId", "noteId", "workspaceId", "parentId", "createdAt", "updatedAt""#,
        )
        .bind(content)
        .bind(kind)
        .bind(metadata)
        .bind(user.id)
        .bind(note_id)
        .bind(ws)
        .bind(parent_id)
        .fetch_one(ctx.state.pool())
        .await?;
        comment_json(&ctx, row, false).await
    }
    .boxed()
}

fn update(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let mut tx = ctx.state.pool().begin().await?;
        let exists: Option<i32> = sqlx::query_scalar(
            r#"SELECT c.id FROM comments c JOIN notes n ON c."noteId"=n.id WHERE c.id=$1 AND n."accountId"=$2 AND c."workspaceId"=$3"#,
        )
        .bind(id)
        .bind(user.id)
        .bind(ws)
        .fetch_optional(&mut *tx)
        .await?;
        if exists.is_none() {
            bail!("annotation not found");
        }
        if let Some(content) = input.get("content").and_then(Value::as_str) {
            sqlx::query(r#"UPDATE comments SET content=$1, "updatedAt"=blinkora_now() WHERE id=$2"#).bind(content).bind(id).execute(&mut *tx).await?;
        }
        if let Some(kind) = input.get("kind").and_then(Value::as_str) {
            sqlx::query(r#"UPDATE comments SET kind=$1, "updatedAt"=blinkora_now() WHERE id=$2"#).bind(kind).bind(id).execute(&mut *tx).await?;
        }
        if let Some(status) = input.get("status").and_then(Value::as_str) {
            sqlx::query(r#"UPDATE comments SET status=$1, "updatedAt"=blinkora_now() WHERE id=$2"#).bind(status).bind(id).execute(&mut *tx).await?;
        }
        if let Some(metadata) = input.get("metadata") {
            sqlx::query(r#"UPDATE comments SET metadata=$1, "updatedAt"=blinkora_now() WHERE id=$2"#).bind(metadata).bind(id).execute(&mut *tx).await?;
        }
        let row = sqlx::query(&comment_select_sql("id=$1"))
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        comment_json(&ctx, row, false).await
    }
    .boxed()
}

fn delete(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        sqlx::query(
            r#"DELETE FROM comments WHERE id IN (
               SELECT c.id FROM comments c JOIN notes n ON c."noteId"=n.id WHERE c.id=$1 AND n."accountId"=$2 AND c."workspaceId"=$3
            )"#,
        )
        .bind(id)
        .bind(user.id)
        .bind(ws)
        .execute(ctx.state.pool())
        .await?;
        Ok(json!({ "ok": true }))
    }
    .boxed()
}

fn convert_to_todo(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut tx = ctx.state.pool().begin().await?;
        let todo = convert_to_todo_tx(&mut tx, user.id, ws, id, content.as_deref()).await?;
        tx.commit().await?;
        Ok(todo)
    }
    .boxed()
}

async fn convert_to_todo_tx(
    tx: &mut Transaction<'_, Sqlite>,
    account_id: i32,
    workspace_id: i32,
    comment_id: i32,
    content: Option<&str>,
) -> anyhow::Result<Value> {
    let row = sqlx::query(
        r#"SELECT c.content, c."noteId" FROM comments c JOIN notes n ON c."noteId"=n.id
               WHERE c.id=$1 AND n."accountId"=$2 AND c."workspaceId"=$3"#,
    )
    .bind(comment_id)
    .bind(account_id)
    .bind(workspace_id)
    .fetch_one(&mut **tx)
    .await?;
    let fallback_content: String = row.get("content");
    let content = content.unwrap_or(&fallback_content);
    let note_id: i32 = row.get("noteId");
    let metadata = json!({
        "source": { "type": "comment", "commentId": comment_id, "noteId": note_id, "capturedAt": chrono::Utc::now() },
        "memory": { "kind": "todo", "status": "candidate", "sourceNoteIds": [note_id], "createdBy": "user" },
        "todo": { "status": "open", "convertedFromCommentId": comment_id, "convertedFromNoteId": note_id }
    });
    let todo_id: i32 = sqlx::query_scalar(
        r#"INSERT INTO notes (content, type, "accountId", "workspaceId", metadata, "updatedAt")
               VALUES ($1,2,$2,$3,$4,blinkora_now()) RETURNING id"#,
    )
    .bind(content)
    .bind(account_id)
    .bind(workspace_id)
    .bind(metadata)
    .fetch_one(&mut **tx)
    .await?;
    let reference = sqlx::query(r#"INSERT INTO "noteReference" ("fromNoteId","toNoteId") VALUES ($1,$2) ON CONFLICT DO NOTHING"#)
            .bind(todo_id)
            .bind(note_id)
            .execute(&mut **tx)
            .await?;
    if reference.rows_affected() != 1 {
        bail!("failed to create Todo reference");
    }
    let updated = sqlx::query(r#"UPDATE comments SET status='resolved', metadata=blinkora_json_merge(COALESCE(metadata,'{}'), $1), "updatedAt"=blinkora_now() WHERE id=$2"#)
            .bind(json!({ "convertedToTodoId": todo_id, "convertedAt": chrono::Utc::now() }))
            .bind(comment_id)
            .execute(&mut **tx)
            .await?;
    if updated.rows_affected() != 1 {
        bail!("annotation not found");
    }

    converted_todo_json_tx(tx, todo_id, account_id, workspace_id).await
}

async fn converted_todo_json_tx(
    tx: &mut Transaction<'_, Sqlite>,
    todo_id: i32,
    account_id: i32,
    workspace_id: i32,
) -> anyhow::Result<Value> {
    let note_row = sqlx::query(&super::notes::note_select_sql("id=$3"))
        .bind(account_id)
        .bind(workspace_id)
        .bind(todo_id)
        .fetch_one(&mut **tx)
        .await?;
    super::common::note_json_with_connection(note_row, tx).await
}

fn comment_select_sql(extra: &str) -> String {
    format!(
        r#"SELECT id, content, kind, status, metadata, "accountId", "noteId", "workspaceId", "parentId", "createdAt", "updatedAt"
           FROM comments WHERE {extra}"#
    )
}

async fn comment_json(
    ctx: &ProcedureContext,
    row: sqlx::sqlite::SqliteRow,
    with_replies: bool,
) -> anyhow::Result<Value> {
    let id = row.get::<i32, _>("id");
    let account_id = row.get::<Option<i32>, _>("accountId");
    let replies = if with_replies {
        let rows = sqlx::query(&comment_select_sql(
            r#""parentId"=$1 ORDER BY "createdAt" ASC, id ASC"#,
        ))
        .bind(id)
        .fetch_all(ctx.state.pool())
        .await?;
        let mut out = Vec::new();
        for row in rows {
            out.push(Box::pin(comment_json(ctx, row, false)).await?);
        }
        out
    } else {
        Vec::new()
    };
    Ok(json!({
        "id": id,
        "content": row.get::<String, _>("content"),
        "kind": row.get::<String, _>("kind"),
        "status": row.get::<String, _>("status"),
        "metadata": row.get::<Option<Value>, _>("metadata"),
        "accountId": account_id,
        "noteId": row.get::<i32, _>("noteId"),
        "workspaceId": row.get::<Option<i32>, _>("workspaceId"),
        "parentId": row.get::<Option<i32>, _>("parentId"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt"),
        "account": match account_id { Some(id) => account_brief(ctx, id).await, None => Value::Null },
        "replies": replies
    }))
}

#[cfg(test)]
mod tests {
    use super::{convert_to_todo, update};
    use crate::{
        app::AppState,
        auth::{AgentPermissions, AuthKind, CurrentUser},
        config::Config,
        trpc::ProcedureContext,
    };
    use serde_json::{json, Value};
    use sqlx::{Row, SqlitePool};
    use std::path::{Path, PathBuf};

    struct ConvertTodoFixture {
        data_dir: PathBuf,
        pool: SqlitePool,
        ctx: ProcedureContext,
        account_id: i32,
        workspace_id: i32,
        note_id: i32,
        comment_id: i32,
    }

    async fn convert_todo_fixture(label: &str) -> ConvertTodoFixture {
        let data_dir = std::env::temp_dir().join(format!(
            "blinkora-comments-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        let pool = crate::db::connect(&data_dir)
            .await
            .expect("open comments test database");
        crate::db::init_schema(
            &pool,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../db/schema.sqlite.sql"),
        )
        .await
        .expect("initialize comments test schema");

        let account_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO accounts (name, password, nickname, image, role, "updatedAt")
               VALUES ('owner', 'hash', 'Owner', 'avatar.png', 'superadmin', blinkora_now())
               RETURNING id"#,
        )
        .fetch_one(&pool)
        .await
        .expect("seed account");
        let workspace_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO workspaces (name, "accountId", "isDefault")
               VALUES ('main', $1, true) RETURNING id"#,
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await
        .expect("seed workspace");
        let note_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO notes (content, "updatedAt", "accountId", "workspaceId")
               VALUES ('source note', blinkora_now(), $1, $2) RETURNING id"#,
        )
        .bind(account_id)
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("seed source note");
        let comment_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO comments (content, metadata, "accountId", "noteId", "workspaceId", "updatedAt")
               VALUES ('comment todo', '{"keep":{"nested":true}}', $1, $2, $3, blinkora_now())
               RETURNING id"#,
        )
        .bind(account_id)
        .bind(note_id)
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("seed comment");

        let state = AppState::new(
            Config {
                bind_addr: "127.0.0.1".into(),
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

        ConvertTodoFixture {
            data_dir,
            pool,
            ctx,
            account_id,
            workspace_id,
            note_id,
            comment_id,
        }
    }

    async fn assert_unconverted(fixture: &ConvertTodoFixture) {
        let todo_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes WHERE type=2")
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        let reference_count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "noteReference""#)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        let comment = sqlx::query(
            r#"SELECT status, metadata, "accountId", "workspaceId" FROM comments WHERE id=$1"#,
        )
        .bind(fixture.comment_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();

        assert_eq!(todo_count, 0, "failed conversion must not leave a Todo");
        assert_eq!(
            reference_count, 0,
            "failed conversion must not leave a reference"
        );
        assert_eq!(comment.get::<String, _>("status"), "open");
        assert_eq!(
            comment.get::<Option<Value>, _>("metadata"),
            Some(json!({ "keep": { "nested": true } }))
        );
        assert_eq!(
            comment.get::<Option<i32>, _>("accountId"),
            Some(fixture.account_id)
        );
        assert_eq!(
            comment.get::<Option<i32>, _>("workspaceId"),
            Some(fixture.workspace_id)
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM accounts WHERE id=$1")
                .bind(fixture.account_id)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workspaces WHERE id=$1")
                .bind(fixture.workspace_id)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM notes WHERE id=$1")
                .bind(fixture.note_id)
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            1
        );
    }

    async fn cleanup(fixture: ConvertTodoFixture) {
        drop(fixture.ctx);
        fixture.pool.close().await;
        tokio::fs::remove_dir_all(fixture.data_dir).await.unwrap();
    }

    #[tokio::test]
    async fn convert_to_todo_commits_all_related_state_and_returns_the_committed_shape() {
        let fixture = convert_todo_fixture("commit").await;
        let todo = convert_to_todo(
            fixture.ctx.clone(),
            json!({ "id": fixture.comment_id, "content": "overridden todo" }),
        )
        .await
        .expect("convert comment to Todo");
        let todo_id = todo.get("id").and_then(Value::as_i64).unwrap() as i32;
        let canonical_row = sqlx::query(&super::super::notes::note_select_sql("id=$3"))
            .bind(fixture.account_id)
            .bind(fixture.workspace_id)
            .bind(todo_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        let canonical = super::super::common::note_json(&fixture.ctx, canonical_row)
            .await
            .unwrap();

        assert_eq!(
            todo, canonical,
            "transactional read must preserve Note shape"
        );
        assert_eq!(todo.get("type"), Some(&json!(2)));
        assert_eq!(todo.get("content"), Some(&json!("overridden todo")));
        assert_eq!(todo.get("accountId"), Some(&json!(fixture.account_id)));
        assert_eq!(todo.get("workspaceId"), Some(&json!(fixture.workspace_id)));
        assert_eq!(todo.get("tags"), Some(&json!([])));
        assert_eq!(todo.get("attachments"), Some(&json!([])));
        assert_eq!(todo.get("referencedBy"), Some(&json!([])));
        assert_eq!(
            todo.pointer("/references/0/fromNoteId"),
            Some(&json!(todo_id))
        );
        assert_eq!(
            todo.pointer("/references/0/toNoteId"),
            Some(&json!(fixture.note_id))
        );
        assert_eq!(
            todo.pointer("/references/0/toNote/content"),
            Some(&json!("source note"))
        );
        assert_eq!(todo.pointer("/account/name"), Some(&json!("owner")));

        let comment = sqlx::query("SELECT status, metadata FROM comments WHERE id=$1")
            .bind(fixture.comment_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        let comment_metadata = comment.get::<Value, _>("metadata");
        assert_eq!(comment.get::<String, _>("status"), "resolved");
        assert_eq!(comment_metadata.pointer("/keep/nested"), Some(&json!(true)));
        assert_eq!(
            comment_metadata.get("convertedToTodoId"),
            Some(&json!(todo_id))
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                r#"SELECT COUNT(*) FROM "noteReference" WHERE "fromNoteId"=$1 AND "toNoteId"=$2"#,
            )
            .bind(todo_id)
            .bind(fixture.note_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
            1
        );
        crate::db::probe(&fixture.pool).await.unwrap();
        cleanup(fixture).await;
    }

    #[tokio::test]
    async fn multi_field_update_is_atomic() {
        let fixture = convert_todo_fixture("update-rollback").await;
        sqlx::query(&format!(
            r#"CREATE TRIGGER fail_comment_status_update BEFORE UPDATE OF status ON comments
               WHEN OLD.id={} BEGIN SELECT RAISE(ABORT, 'forced comment update failure'); END"#,
            fixture.comment_id
        ))
        .execute(&fixture.pool)
        .await
        .unwrap();

        update(
            fixture.ctx.clone(),
            json!({
                "id": fixture.comment_id,
                "content": "changed",
                "kind": "instruction",
                "status": "resolved",
                "metadata": { "changed": true }
            }),
        )
        .await
        .expect_err("a later field failure must roll back earlier fields");
        let unchanged =
            sqlx::query("SELECT content, kind, status, metadata FROM comments WHERE id=$1")
                .bind(fixture.comment_id)
                .fetch_one(&fixture.pool)
                .await
                .unwrap();
        assert_eq!(unchanged.get::<String, _>("content"), "comment todo");
        assert_eq!(unchanged.get::<String, _>("kind"), "annotation");
        assert_eq!(unchanged.get::<String, _>("status"), "open");
        assert_eq!(
            unchanged.get::<Option<Value>, _>("metadata"),
            Some(json!({ "keep": { "nested": true } }))
        );
        sqlx::query("DROP TRIGGER fail_comment_status_update")
            .execute(&fixture.pool)
            .await
            .unwrap();

        let changed = update(
            fixture.ctx.clone(),
            json!({
                "id": fixture.comment_id,
                "content": "changed",
                "kind": "instruction",
                "status": "resolved",
                "metadata": { "changed": true }
            }),
        )
        .await
        .unwrap();
        assert_eq!(changed.get("content"), Some(&json!("changed")));
        assert_eq!(changed.get("kind"), Some(&json!("instruction")));
        assert_eq!(changed.get("status"), Some(&json!("resolved")));
        assert_eq!(changed.get("metadata"), Some(&json!({ "changed": true })));
        crate::db::probe(&fixture.pool).await.unwrap();
        cleanup(fixture).await;
    }

    #[tokio::test]
    async fn convert_to_todo_rolls_back_when_reference_creation_fails() {
        let fixture = convert_todo_fixture("reference-rollback").await;
        sqlx::query(
            r#"CREATE TRIGGER fail_comment_todo_reference
               BEFORE INSERT ON "noteReference"
               BEGIN
                 SELECT RAISE(ABORT, 'forced reference failure');
               END"#,
        )
        .execute(&fixture.pool)
        .await
        .unwrap();

        let error = convert_to_todo(fixture.ctx.clone(), json!({ "id": fixture.comment_id }))
            .await
            .expect_err("reference failure must fail the conversion");
        assert!(error.to_string().contains("forced reference failure"));
        assert_unconverted(&fixture).await;
        crate::db::probe(&fixture.pool).await.unwrap();
        cleanup(fixture).await;
    }

    #[tokio::test]
    async fn convert_to_todo_rolls_back_when_the_final_read_fails() {
        let fixture = convert_todo_fixture("final-read-rollback").await;
        sqlx::query(&format!(
            r#"CREATE TRIGGER fail_comment_todo_final_read
               AFTER UPDATE OF status ON comments
               WHEN NEW.id={} AND NEW.status='resolved'
               BEGIN
                 DELETE FROM accounts WHERE id=NEW."accountId";
               END"#,
            fixture.comment_id
        ))
        .execute(&fixture.pool)
        .await
        .unwrap();

        let error = convert_to_todo(fixture.ctx.clone(), json!({ "id": fixture.comment_id }))
            .await
            .expect_err("final read failure must fail the conversion");
        assert!(error.to_string().contains("no rows returned"));
        assert_unconverted(&fixture).await;
        crate::db::probe(&fixture.pool).await.unwrap();
        cleanup(fixture).await;
    }
}
