use crate::app::AppState;
use crate::auth::CurrentUser;
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/mcp-guide.md", get(mcp_guide))
        .route("/blinkora-workspace/SKILL.md", get(skill_md))
        .route("/blinkora-workspace.zip", get(skill_zip))
}

async fn mcp_guide(_user: CurrentUser) -> Response {
    markdown_response(MCP_GUIDE_MD)
}

async fn skill_md(_user: CurrentUser) -> Response {
    let mut response = markdown_response(BLINKORA_WORKSPACE_SKILL_MD);
    response.headers_mut().insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"SKILL.md\""),
    );
    response
}

async fn skill_zip(_user: CurrentUser) -> Response {
    match build_skill_zip() {
        Ok(body) => {
            let mut response = (StatusCode::OK, body).into_response();
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("application/zip"));
            response.headers_mut().insert(
                CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"blinkora-workspace.zip\""),
            );
            response
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to build skill zip: {error}"),
        )
            .into_response(),
    }
}

fn markdown_response(content: &'static str) -> Response {
    let mut response = (StatusCode::OK, content).into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/markdown; charset=utf-8"),
    );
    response
}

fn build_skill_zip() -> anyhow::Result<Vec<u8>> {
    let cursor = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("blinkora-workspace/SKILL.md", options)?;
    zip.write_all(BLINKORA_WORKSPACE_SKILL_MD.as_bytes())?;
    Ok(zip.finish()?.into_inner())
}

const MCP_GUIDE_MD: &str = r#"# Blinkora MCP / Skill 接入指南

这些资源只用于安装和加载 Agent Skill，不包含业务数据。任意有效的 Blinkora 工作区令牌都可以读取和下载它们；真正的笔记、评论、标签访问仍由令牌绑定的单个 Workspace 强制隔离。

## 环境变量

```bash
export BLINKORA_BASE_URL="http://localhost:6676"
export BLINKORA_AGENT_TOKEN="bkws_xxx"
```

## MCP

- SSE endpoint: `${BLINKORA_BASE_URL}/sse`
- 每次请求都带：`Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`
- 不要传 `workspaceId`，工作区由令牌绑定。

可用工具：

- `getWorkspaceContext`
- `searchBlinkora`
- `getBlinkora`
- `upsertBlinkora`
- `updateBlinkora`
- `deleteBlinkora`
- `listReferences`
- `addReference`
- `removeReference`
- `setReferences`
- `listComments`
- `createComment`
- `updateComment`
- `listTagTree`

## 下载 Skill

```bash
mkdir -p .agents/skills/blinkora-workspace
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md" \
  -o .agents/skills/blinkora-workspace/SKILL.md
```

也可以下载 zip：

```bash
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace.zip" \
  -o blinkora-workspace.zip
```

读取在线指南：

```bash
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/mcp-guide.md"
```

## 安全边界

- 工作区令牌只能访问被绑定的单个 Workspace。
- 可读写闪念、笔记、待办、评论和笔记引用。
- 可读取标签树；通过正文 hashtag 自动同步标签。
- 不能访问其他 Workspace、文件、备份、配置和管理接口。
- 不要把 token 写进仓库、脚本、提交记录或公开日志。
"#;

const BLINKORA_WORKSPACE_SKILL_MD: &str = r#"---
name: blinkora-workspace
description: Use when an agent needs workspace-scoped access to Blinkora notes, blinkoras, todos, comments, and the tag tree through Blinkora MCP with BLINKORA_BASE_URL and BLINKORA_AGENT_TOKEN.
---

# Blinkora Workspace

Use this skill to operate one authorized Blinkora workspace from an external Agent such as Codex, OpenClaw, Pi Agent, or Hermes.

## Environment

Require these environment variables:

- `BLINKORA_BASE_URL`: Blinkora Web/API base URL, for example `http://localhost:6676`.
- `BLINKORA_AGENT_TOKEN`: Workspace-scoped token created in Blinkora settings.

Never write the token into a repo file, script, skill, shell history snippet, or log. Treat it as a secret. The skill does not provide security isolation; Blinkora backend enforces workspace scope.

## Install / Refresh

If the agent supports project skills, install this skill into the workspace:

```bash
mkdir -p .agents/skills/blinkora-workspace
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md" \
  -o .agents/skills/blinkora-workspace/SKILL.md
```

If the agent does not support local skills, read the same `SKILL.md` as task instructions and then connect through MCP.

## Connect

Prefer Blinkora MCP over raw HTTP.

- SSE endpoint: `${BLINKORA_BASE_URL}/sse`
- Message endpoint is returned by the SSE `endpoint` event.
- Authenticate every MCP request with `Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`.

The token is bound to exactly one workspace. Do not pass or invent `workspaceId`; scoped tokens use their bound workspace.

## Tools

Available note types:

- `0` or `blinkora`: flash thought
- `1` or `note`: note
- `2` or `todo`: todo

Prefer these MCP tools:

- `getWorkspaceContext`: confirm the account and workspace bound to the token before large writes.
- `searchBlinkora`: read notes with `page` and `size`; always paginate for broad reads.
- `getBlinkora`: read one note by `id`.
- `upsertBlinkora`: create a flash thought, note, or todo.
- `updateBlinkora`: update a note by `id`.
- `deleteBlinkora`: move notes to recycle bin.
- `listReferences`: read outgoing and incoming note references.
- `addReference`: create one note-to-note reference.
- `removeReference`: remove one note-to-note reference.
- `setReferences`: replace all outgoing references for one note.
- `listComments`: read comments for a note.
- `createComment`: create a comment for a note.
- `updateComment`: update a comment by `id`.
- `listTagTree`: read the current workspace tag tree.

`upsertBlinkora` and `updateBlinkora` accept optional `metadata` and `references`.
Use `metadata` for machine-readable maintenance fields such as `importSourceKey`, `sourcePath`, `sha256`, or `schema`.
Use `references` as an array of target note ids when the complete outgoing reference set is known.
Use `searchBlinkora` with `metadata` or `metadataContains` for top-level exact metadata matching.

## Write Rules

Before writing:

- Confirm the target type: `blinkora`, `note`, or `todo`.
- Confirm note ids and comment ids by reading them first when the user did not provide exact ids.
- For large edits, read the current object first and preserve fields not being changed.
- Do not try to read or write attachment files; only use attachment metadata already returned with notes.
- Do not modify the tag tree directly. To assign tags, write hashtags in content, for example `#自媒体成长/类型/概念`; Blinkora will create and sync the tag tree.
- For idempotent imports, write a stable marker in content and a stable `metadata.importSourceKey`, then search by that metadata before creating a new note.
- For wiki-style migrations, create notes first, then run a second pass to call `setReferences` after all target ids are known.

When reading all content, use pages until the result page is empty or shorter than requested. Keep page size reasonable, normally 50 to 200.
"#;
