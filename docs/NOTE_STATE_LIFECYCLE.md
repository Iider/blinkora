# 笔记状态模型

Blinkora 的闪念、笔记和待办都存放在 `notes` 表。归档和回收站不是独立区域或独立表，而是同一条笔记上的状态字段。

## 字段

- `type`：内容类型。`0` 是闪念，`1` 是笔记，`2` 是待办。
- `isArchived`：归档状态。普通列表默认只显示 `false`，归档页显示 `true`。
- `isRecycle`：回收站状态。回收站列表显示 `true`，普通列表和归档列表都排除它。
- `isTop`：置顶状态。列表排序先按它倒序，再按排序值和时间。
- `isReviewed`：每日回顾状态。每日回顾只取未回顾、未归档、未回收的内容。

## 列表筛选

`notes.list` 的状态筛选规则：

- 未传 `isArchived`：默认查询 `isArchived=false`。
- `isArchived=true`：查询归档区。
- `isArchived=false`：查询普通区。
- `isArchived=null`：不按归档状态筛选，用于全局搜索这类跨区查询。
- `isRecycle=true`：查询回收站；回收站优先于归档筛选。

## 状态写入

- 单条卡片的归档、恢复、置顶、回顾状态走 `notes.upsert`。
- 多选归档、恢复和置顶走 `notes.updateMany`。
- 移入回收站走 `notes.trashMany`。
- 彻底删除走 `notes.deleteMany`，同时清理引用、评论、附件关系、孤立标签和 RAG 向量。
- 跨工作区移动走 `notes.moveToWorkspace`。它不改变 `type`、`isArchived`、`isTop`、`isReviewed`，回收站卡片不允许移动；批量移动也复用这个接口。

状态更新必须支持“只改状态，不改正文”。前端按钮不应该为了归档或恢复额外提交正文。

## 维护同步点

新增或修改笔记状态字段时，同时检查：

- `server/src/handlers/notes.rs`：`list`、`upsert`、`updateMany` 和删除清理。
- `server/src/handlers/common.rs`：接口返回 JSON。
- `server/src/handlers/backup.rs`：备份导出和恢复。
- `server/src/handlers/mcp.rs`：MCP 工具入参 schema。
- `server/src/rag.rs`：索引元数据和查询过滤。
- `app/src/store/blinkoraStore.tsx`：各页面列表筛选。
- `scripts/rust-smoke.mjs`：至少覆盖归档、归档列表可见、恢复。

## 验收

- 对普通闪念或笔记执行归档后，原列表不再显示，`/?path=archived` 可见。
- 在归档页恢复后，内容回到对应类型列表。
- 全局搜索可按需要跨普通区和归档区查询。
- 回收站内容不应出现在普通区或归档区。
- `bun run verify:rust` 通过。
