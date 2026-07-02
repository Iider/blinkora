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
- `listOperationLogs`

要点：

- `searchBlinkora` 是普通关键词和 metadata 检索，不提供语义、向量、embedding 或 RAG 搜索。
- 常用筛选：`searchText`、`type`、`isArchived`、`isRecycle`、`tagId`、`withoutTag`、`withFile`、`withLink`、`hasTodo`、`startDate`、`endDate`、`metadata` / `metadataContains`。
- `isArchived` 默认只查未归档；传 `true` 查归档，传 `null` 同时查普通和归档。`isRecycle: true` 查回收站。
- `isReviewed` 表示每日回顾状态，不表示审核、审批或内容审计。
- `metadata.properties` 是给人看的自定义属性，只放扁平值：字符串、数字、布尔、`null` 或字符串数组。修改属性前先读原笔记并合并完整 `metadata`，不要覆盖导入键、来源、哈希等维护字段。
- `deleteBlinkora` 只移入回收站；MCP 不暴露彻底删除、附件写入/管理或跨 Workspace 移动。
- 笔记返回的附件路径可以用工作区令牌读取：`GET ${BLINKORA_BASE_URL}/api/file/...` 或 `/api/s3file/...`，请求继续携带 `Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`。
- `listOperationLogs` 读取系统级操作日志；Agent 可用 `afterId` 做增量同步，默认建议筛选 `actorType: "user"`。日志 action `markDailyReviewed` / `markDailyUnreviewed` 表示每日回顾状态变化，不是审核。

自定义属性写入示例：

```json
{
  "id": 123,
  "metadata": {
    "importSourceKey": "保留原有维护字段",
    "properties": {
      "status": "open",
      "rating": 4,
      "tags": ["AI", "workflow"]
    }
  }
}
```

卡片关联写入示例：

```json
{
  "fromNoteId": 123,
  "toNoteIds": [456, 789]
}
```

单条增删用 `addReference` / `removeReference`；完整替换某张卡片的出链时才用 `setReferences`。

## 使用边界

- MCP 和 Skill 只描述 Blinkora 的通用读写能力、安全边界和数据字段。
- 具体工作区怎么写、怎么分类、保留什么内容、如何使用标签和引用，应写在该工作区或项目自己的 `AGENTS.md`。
- `metadata` 可保存导入键、外部 ID、来源路径、哈希、schema、自定义属性或工作流状态；具体字段语义由对应 `AGENTS.md` 约定。

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
- 可读写闪念、笔记、待办、评论、笔记引用和 metadata 自定义属性。
- 可读取标签树；通过正文 hashtag 自动同步标签。
- 不能访问其他 Workspace、附件写入/管理、备份、配置和管理接口。
- 不要把 token 写进仓库、脚本、提交记录或公开日志。
"#;

const BLINKORA_WORKSPACE_SKILL_MD: &str = r#"---
name: blinkora-workspace
description: Use when an agent needs workspace-scoped access to Blinkora notes, blinkoras, todos, comments, note references, custom note properties, operation logs, read-only attachment files, and the tag tree through Blinkora MCP with BLINKORA_BASE_URL and BLINKORA_AGENT_TOKEN.
---

# Blinkora Workspace

Operate one authorized Blinkora workspace from an external Agent such as Codex, OpenClaw, Pi Agent, or Hermes.

## Environment

Require these environment variables:

- `BLINKORA_BASE_URL`: Blinkora Web/API base URL, for example `http://localhost:6676`.
- `BLINKORA_AGENT_TOKEN`: Workspace-scoped token created in Blinkora settings.

Never write the token into a repo file, script, skill, shell history snippet, or log. Treat it as a secret. Local instructions do not provide security isolation; Blinkora backend enforces workspace scope.

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
- `listOperationLogs`: read note operation logs. Use `afterId` as a cursor for incremental sync.

Returned notes include `id`, `type`, `content`, status flags, `metadata`, tags, attachment metadata, outgoing `references`, incoming `referencedBy`, and timestamps.

Attachment metadata may include `/api/file/...` or `/api/s3file/...` paths. To read the file bytes, send a `GET` request to `${BLINKORA_BASE_URL}${path}` with `Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`. Workspace tokens cannot upload, delete, move, or rename attachment files.

`searchBlinkora` supports ordinary keyword and metadata search only; do not assume semantic, vector, embedding, or RAG search exists. Useful filters include `searchText`, `type`, `isArchived`, `isRecycle`, `tagId`, `withoutTag`, `withFile`, `withLink`, `hasTodo`, `startDate`, `endDate`, `metadata` / `metadataContains`, and `includePageInfo`.

`isArchived` defaults to `false`; pass `true` for archived notes and `null` to search both normal and archived notes. Pass `isRecycle: true` for recycle-bin notes. `deleteBlinkora` only moves notes to the recycle bin; MCP does not expose hard deletion.

`upsertBlinkora` and `updateBlinkora` accept optional status flags, `metadata`, and `references`. On update, omit `content`, `type`, `isArchived`, `isRecycle`, `isTop`, or `isReviewed` to keep the current value. `isReviewed` means daily-review status, not moderation or approval.

Use `listOperationLogs({ afterId, actorType: "user", noteTypes: [1], orderBy: "asc" })` before maintenance work when you need to see user changes since the last agent pass. Operation log actions `markDailyReviewed` and `markDailyUnreviewed` mean daily-review state changes, not approval or content audit.

Use `metadata` for machine-readable maintenance fields such as `importSourceKey`, `sourcePath`, `sourceUrl`, `sha256`, `originalType`, `originalTitle`, `externalId`, `schema`, or workflow-specific state.
Use `metadata.properties` for human-readable custom properties shown in Blinkora. Keep properties flat: `string`, `number`, `boolean`, `null`, or `string[]`.
When changing only properties, read the note first and merge into the full existing `metadata`; writing `metadata` replaces the whole metadata object.
Use `references` as an array of target note ids when the complete outgoing reference set is known.
Use `searchBlinkora` with `metadata` or `metadataContains` for JSON subset matching, for example `{ "properties": { "status": "open" } }`.

Custom property update pattern:

```json
{
  "id": 123,
  "metadata": {
    "importSourceKey": "keep-existing-maintenance-fields",
    "properties": {
      "status": "open",
      "rating": 4,
      "tags": ["AI", "workflow"]
    }
  }
}
```

Reference update pattern:

```json
{
  "fromNoteId": 123,
  "toNoteIds": [456, 789]
}
```

Use `addReference` or `removeReference` for one reference. `removeReference` can clean up existing references that touch recycle-bin notes; prefer passing the reference `id` when known, otherwise pass `fromNoteId` and `toNoteId`. Use `setReferences` only when replacing the complete outgoing reference set for `fromNoteId`.

## Write Rules

Before writing:

- Confirm the target type: `blinkora`, `note`, or `todo`.
- Confirm note ids and comment ids by reading them first when the user did not provide exact ids.
- For large edits, read the current object first and preserve fields not being changed.
- You may read attachment file bytes from attachment paths returned by Blinkora. Do not upload, delete, move, or rename attachment files.
- Do not move notes between workspaces; workspace-scoped tokens cannot call workspace management or move endpoints.
- Do not modify the tag tree directly. To assign tags, write hashtags in content, for example `#项目/类型/概念`; Blinkora will create and sync the tag tree.
- For idempotent imports, use a stable `metadata.importSourceKey` or another stable workflow key, then search by that metadata before creating a new note.
- For migrations or graph-style writes, create or update notes first, then run a second pass to call `setReferences` after all target ids are known.
- Domain-specific writing rules, taxonomy, content retention policy, and card/wiki conventions belong in the target workspace or project `AGENTS.md`, not in this generic Blinkora skill.

When reading all content, use pages until the result page is empty or shorter than requested. Keep page size reasonable, normally 50 to 200.
"#;
