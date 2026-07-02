# 工作区令牌、MCP 和 Skill 接入

Blinkora 的工作区令牌用于把单个 Workspace 授权给外部 Agent，例如 Codex、OpenClaw、Pi Agent、Hermes。它不是账号访问令牌，不能跨 Workspace 使用。

## 设置页怎么用

入口：`/settings` -> `基本信息` -> `工作区令牌`。

- 左侧是说明和“给 AI 的调用指南”。
- 右侧下拉框选择要授权的 Workspace。
- 刷新按钮只更新下拉框选中的 Workspace 令牌，不受页面顶栏当前 Workspace 影响。
- 刷新会撤销该 Workspace 旧的可用工作区令牌，并生成新的可回显令牌。
- 指南内容可以整段复制给 AI，里面包含 token、MCP endpoint、Skill 下载命令和权限边界。

已有令牌如果没有保存明文，设置页无法直接显示。遇到指南提示令牌不可回显时，点击刷新生成新令牌即可。

## Token 存储和安全边界

- token 格式：`bkws_...`。
- 数据库保存 `tokenHash` 用于认证，也保存 `token` 明文用于设置页回显。
- 数据库备份要按敏感数据处理。
- 不要把 token 写进仓库、脚本、提交记录、公开日志或 Skill 文件。
- 工作区令牌只能访问绑定的单个 Workspace。
- 允许：闪念、笔记、待办、评论、笔记引用和 metadata 自定义属性读写；标签树可读；同 Workspace 附件文件可读取。
- 禁止：其他 Workspace、附件写入和管理、备份、配置、工作区管理和 admin 类接口。

## MCP 使用

把设置页指南里的变量交给 Agent：

```bash
export BLINKORA_BASE_URL="http://localhost:6676"
export BLINKORA_AGENT_TOKEN="bkws_xxx"
```

MCP 入口：

```text
${BLINKORA_BASE_URL}/sse
```

认证头：

```text
Authorization: Bearer ${BLINKORA_AGENT_TOKEN}
```

不要传 `workspaceId`。后端会强制使用 token 绑定的 Workspace；如果请求里带了不匹配的 `x-workspace-id`，会被拒绝。

可用 MCP 工具：

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

Agent 批量导入或维护时建议：

- 先调用 `getWorkspaceContext` 确认 token 绑定的 Workspace。
- `searchBlinkora` 是普通关键词和 metadata 检索，不提供语义、向量、embedding 或 RAG 搜索。
- 常用筛选：`searchText`、`type`、`isArchived`、`isRecycle`、`tagId`、`withoutTag`、`withFile`、`withLink`、`hasTodo`、`startDate`、`endDate`、`metadata` / `metadataContains`。
- `isArchived` 默认只查未归档；传 `true` 查归档，传 `null` 同时查普通和归档。`isRecycle: true` 查回收站。
- `isReviewed` 表示每日回顾状态，不表示审核、审批或内容审计。
- 用 `metadata.importSourceKey`、`metadata.sha256` 或其他稳定 workflow key 做幂等导入。
- 用 `searchBlinkora` 的 `metadata` / `metadataContains` 做 JSON 子集匹配，避免靠全文搜索猜记录。
- `metadata.properties` 是给人看的自定义属性，只放扁平值：字符串、数字、布尔、`null` 或字符串数组。
- 修改 `metadata.properties` 前先读原笔记并合并完整 `metadata`；`updateBlinkora` 传入 `metadata` 时会替换整个 metadata 对象，不要丢掉导入键、来源、哈希等维护字段。
- `updateBlinkora` 未传 `content`、`type`、`isArchived`、`isRecycle`、`isTop`、`isReviewed` 时保持原值。
- 先创建全部笔记，再用 `setReferences` 第二轮写入笔记间引用。
- 通过正文写 `#父/子` 形式的标签，不直接写标签树。
- 维护卡片前需要追踪用户改动时，用 `listOperationLogs` 读取系统级操作日志，不依赖“操作日志”卡片作为事实来源。
- 推荐增量查询：`listOperationLogs({ "afterId": 上次处理到的日志 id, "actorType": "user", "noteTypes": [1], "orderBy": "asc" })`。
- 工作区令牌可以读取笔记返回的 `/api/file/...` 或 `/api/s3file/...` 附件路径；读取时继续携带 `Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`。
- 工作区令牌不能上传、删除、移动或重命名附件文件，不能彻底删除笔记，也不能跨 Workspace 移动卡片。
- 具体工作区的内容保留策略、标签语义、metadata 字段语义、卡片或 wiki 写法，放到该工作区或项目的 `AGENTS.md`。

常见写法：

自定义属性写到 `metadata.properties`。先读原笔记，再把原有 `metadata` 合并回去：

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

卡片关联用笔记 id 写有向引用。完整替换某张卡片的出链时调用 `setReferences`：

```json
{
  "fromNoteId": 123,
  "toNoteIds": [456, 789]
}
```

只增删一条引用时，用 `addReference` 或 `removeReference`，不要为了单条修改误用 `setReferences` 覆盖整组出链。
`removeReference` 可以清理涉及回收站笔记的既有引用；已知引用 `id` 时优先传 `id`，没有 `id` 时再传 `fromNoteId` / `toNoteId`。

## Skill 和文档资源

这些只读资源用于让 AI 安装或加载 Blinkora Workspace Skill。任意有效工作区令牌都可以访问这些资源，但业务数据仍按 token 绑定的 Workspace 隔离。

- 在线指南：`${BLINKORA_BASE_URL}/api/agent/mcp-guide.md`
- Skill Markdown：`${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md`
- Skill zip：`${BLINKORA_BASE_URL}/api/agent/blinkora-workspace.zip`

安装到项目级 `.agents`：

```bash
mkdir -p .agents/skills/blinkora-workspace
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md" \
  -o .agents/skills/blinkora-workspace/SKILL.md
```

下载 zip：

```bash
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace.zip" \
  -o blinkora-workspace.zip
```

只读查看在线指南：

```bash
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/mcp-guide.md"
```

## 烟测重点

每次改工作区令牌、MCP 或 Skill 资源后，至少确认这些项：

- 自动专项 smoke：

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_ACCOUNT_TOKEN=<account_jwt> \
bun run smoke:agent
```

- 未鉴权访问 `/api/agent/*` 返回 `401`。
- 创建工作区令牌后，`agentTokens.list` 能回显 token，且不返回 `tokenHash`。
- 刷新同一 Workspace 后，旧 token 失效，新 token 可用。
- 用 Workspace A token 调用 `getWorkspaceContext` 返回 Workspace A。
- 用 Workspace A token 搜索不到 Workspace B 内容。
- 用 Workspace A token 携带 Workspace B 的 `x-workspace-id` 返回 `401`。
- 用工作区令牌调用 `workspaces.list` / `config.list` 返回 `403`。
- 用工作区令牌能读取绑定 Workspace 的附件文件，但不能调用 `/api/file/upload`、`/api/file/delete` 或 `attachments.*` 管理接口。
- 用工作区令牌连接 MCP 后，工具列表只包含 workspace context、note、reference、comment、tag tree、operation log 相关工具。
- `getWorkspaceContext`、`searchBlinkora`、`getBlinkora`、`upsertBlinkora`、`updateBlinkora`、`listReferences`、`addReference`、`removeReference`、`setReferences`、`listComments`、`createComment`、`updateComment`、`listTagTree`、`listOperationLogs` 主路径可用。
- `listOperationLogs` 支持 `afterId`、`actorType`、`noteTypes`、`actions`、`changedField` 等筛选，默认操作日志设置只记录笔记类型 `1`。
- `/api/agent/mcp-guide.md`、`/api/agent/blinkora-workspace/SKILL.md`、`/api/agent/blinkora-workspace.zip` 能被任意有效工作区令牌读取或下载。
