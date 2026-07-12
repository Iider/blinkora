# Blinkora MCP / Skill 接入指南

这些资源只用于安装和加载 Agent Skill，不包含业务数据。任意有效的
Blinkora 工作区令牌都可以读取和下载它们；真正的笔记、评论、标签访问仍由令牌绑定的
单个 Workspace 强制隔离。

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
- `cleanupOrphanTags`
- `listOperationLogs`

## 关键规则

- `searchBlinkora` 是普通关键词和 metadata 检索，不提供语义、向量、embedding 或 RAG 搜索。
- 常用筛选：`searchText`、`type`、`isArchived`、`isRecycle`、`tagId`、`withoutTag`、`withFile`、`withLink`、`hasTodo`、`startDate`、`endDate`、`metadata` / `metadataContains`。
- `isArchived` 默认只查未归档；传 `true` 查归档，传 `null` 同时查普通和归档。 `isRecycle: true` 查回收站。
- `isReviewed` 表示每日回顾状态，不表示审核、审批或内容审计。
- `tags` 是只读派生结果，不是独立可写字段。新增、移除或重命名卡片标签时，先读原笔记，修改 `content` 里的 hashtag，再调用 `updateBlinkora`；Blinkora 会自动同步标签树和卡片标签关系。
- 正文清理后仍留在 `listTagTree` 的 0 引用历史孤标签，可先用 `cleanupOrphanTags({ "dryRun": true })` 预览，再对确认的孤标签 id 或 `all: true` 执行清理。这个工具不能用于维护某张卡片的标签。
- `metadata.properties` 是给人看的自定义属性，只放扁平值：字符串、数字、布尔、`null` 或字符串数组。修改属性前先读原笔记并合并完整 `metadata`，不要覆盖导入键、来源、哈希等维护字段。
- `deleteBlinkora` 只移入回收站；MCP 不暴露彻底删除、附件写入/管理或跨 Workspace 移动。
- 已知引用 id 时，`removeReference` 优先传 `id`；否则传 `fromNoteId` 和 `toNoteId`。它可以清理涉及回收站笔记的既有引用。
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
- 卡片讨论交接默认只读：收到卡片 id、标题、工作区和链接后，先用 `getBlinkora(id)` 读取最新内容；只有用户明确要求写回时才重新读取并更新卡片。

## 下载完整 Skill 包

完整 zip 同时包含 `SKILL.md`、本指南和直接调用 MCP 时需要的参考文件：

```bash
mkdir -p .agents/skills
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace.zip" \
  -o /tmp/blinkora-workspace.zip
unzip -oq /tmp/blinkora-workspace.zip -d .agents/skills
```

只需要阅读主 Skill 时：

```bash
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md"
```

## 安全边界

- 工作区令牌只能访问被绑定的单个 Workspace。
- 可读写闪念、笔记、待办、评论、笔记引用和 metadata 自定义属性。
- 可读取标签树；通过正文 hashtag 自动同步标签；可清理 0 引用且无子标签的历史孤标签。
- 不能访问其他 Workspace、附件写入/管理、备份、配置和管理接口。
- 不要把 token 写进仓库、脚本、提交记录或公开日志。
