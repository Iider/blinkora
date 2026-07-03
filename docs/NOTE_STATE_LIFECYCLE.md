# 笔记状态模型

Blinkora 的闪念、笔记和待办都存放在 `notes` 表。归档和回收站不是独立区域或独立表，而是同一条笔记上的状态字段。

## 字段

- `type`：内容类型。`0` 是闪念，`1` 是笔记，`2` 是待办。
- `isArchived`：归档状态。普通列表默认只显示 `false`，归档页显示 `true`。
- `isRecycle`：回收站状态。回收站列表显示 `true`，普通列表和归档列表都排除它。
- `isTop`：置顶状态。列表排序先按它倒序，再按排序值和时间。
- `isReviewed`：每日回顾状态。每日回顾只取未回顾、未归档、未回收的内容。

## 术语边界

`review`、`reviewed`、`isReviewed` 在 Blinkora 里统一表示“每日回顾/已回顾”。它们不是审核、审批、发布审查或内容安全审计。

操作日志对外 action 使用 `markDailyReviewed` / `markDailyUnreviewed` 表达每日回顾状态变化，避免把回顾误读成审核。

如果以后要做真正的审核流程，需要单独设计状态模型和接口，不要复用 `isReviewed`。

## 列表筛选

`notes.list` 的状态筛选规则：

- 未传 `isArchived`：默认查询 `isArchived=false`。
- `isArchived=true`：查询归档区。
- `isArchived=false`：查询普通区。
- `isArchived=null`：不按归档状态筛选，用于全局搜索这类跨区查询。
- `isRecycle=true`：查询回收站；回收站优先于归档筛选。

## 状态写入

- 单条卡片的归档、恢复、置顶、每日回顾状态走 `notes.upsert`。
- 单条卡片的类型转换也走 `notes.upsert`，只写 `type`，不提交正文。
- 多选归档、恢复和置顶走 `notes.updateMany`。
- 移入回收站走 `notes.trashMany`。
- 彻底删除走 `notes.deleteMany`，同时清理引用、评论、附件关系和孤立标签。
- 跨工作区移动走 `notes.moveToWorkspace`。它不改变 `type`、`isArchived`、`isTop`、`isReviewed`，回收站卡片不允许移动；批量移动也复用这个接口。

状态更新必须支持“只改状态，不改正文”。前端按钮不应该为了归档或恢复额外提交正文。

## 类型转换入口

闪念、笔记、待办之间可以互相转换。入口：

- 卡片左下角类型标识：点击后弹出三种类型，选择目标类型。
- 卡片右键菜单和右上角三个点菜单：只显示当前类型以外的两个目标类型。

转换后，卡片应从当前类型列表移到目标类型列表；正文、标签、附件、评论、历史和归档状态保持不变。

## 列表呈现和打开交互

卡片列表的呈现方式和点开后的交互方式分开判断：

- 列表呈现：短内容按普通卡片渲染；超过 `textFoldLength` 判定为长内容后，按文章预览渲染。
- 打开和编辑：`cardInteractionMode=article` 时，所有卡片点击后进入全屏阅读，编辑入口在全屏页右上角；`cardInteractionMode=auto` 时，短内容保留普通卡片编辑交互，长内容进入全屏阅读。
- 列表卡片：鼠标移入卡片时，右上角操作组显示导出 Markdown、复制、评论、删除/回收站等快捷动作。
- 全屏阅读：返回、导出 Markdown、复制、评论、删除/回收站和编辑/预览切换统一放在顶部操作栏；移动端不再保留底部操作栏；安卓套壳 App 的系统返回通过 `blinkora:native-back` 事件接入，编辑态先退回预览，预览态关闭全屏阅读。
- 默认值：没有配置或配置非法时按 `article` 处理。
- `forceBlog` 调用方仍可强制走文章预览和全屏交互。

`articlePreviewLineLimit` 只控制文章预览在普通折叠态展示的摘要行数，不改变全文阅读、普通短卡片呈现和内容保存。

普通短卡片的列表排版：

- 仍完整渲染 Markdown，不按 `articlePreviewLineLimit` 截断。
- 复用文章卡片的紧凑字号和行距。
- 第一条可读行是 Markdown 标题时，标题使用主文字色，正文使用描述色。
- 第一条可读行不是 Markdown 标题时，整张卡片使用主文字色。

## 卡背

列表卡片有一个只读卡背，用来快速查看正文之外的人可读信息：

- 点击卡片顶部空白/边缘区域翻到卡背，再点顶部翻回正面。
- 卡片顶部仍保留长按拖动；多选模式下点击顶部优先选择卡片，不触发翻面。
- 卡背顶部展示类型、一条到分钟的时间和三点菜单：如果正面展示更新时间，卡背展示创建时间；如果正面展示创建时间，卡背展示更新时间。
- 卡背只展示特殊状态：置顶、归档、回收站、已回顾、离线、待办截止时间。没有特殊状态时不显示状态区，也不放占位符。
- 卡背展示 `metadata.properties` 自定义属性；不展示标签、附件数、评论数、引用数、被引用数，也不单独展示时间区块。
- 卡背不展示 `id`、`accountId`、`workspaceId`、导入来源等内部或维护字段。
- 卡背只读；自定义属性的编辑仍在全屏阅读底部的属性表格里完成。

## 引用展示

- 普通列表卡片不展示引用摘要，避免卡片高度被引用关系拉长。
- 全屏阅读和详情浮层保留引用展示。
- 引用卡片只显示对端卡片第一条可读行的纯文本；Markdown 标题会去掉开头 `#`，不会按标题样式渲染。
- A 引用 B 且 B 也引用 A 时，展示为一条“互相引用”；数据库和 API 仍保留两条有向引用。

## 自定义属性

笔记不新增 `title` 字段，也不新增独立属性表。第一版自定义属性统一放在 `notes.metadata.properties`：

```json
{
  "properties": {
    "type": "permanent",
    "source": "B站视频",
    "status": "待整理",
    "rating": 4,
    "tags": ["自媒体", "IP"]
  }
}
```

约定：

- 只支持扁平值：`string`、`number`、`boolean`、`null`、`string[]`。
- 保存属性时只替换 `metadata.properties`，不能覆盖 `metadata` 下的导入来源等系统字段。
- 属性编辑区使用两列表格填写“属性 / 内容”；空白行不保存，清空所有行后从 `metadata` 中移除 `properties`。
- 属性内容按单个 YAML 值解析，普通文字直接保存，`4`、`true`、`null`、`[自媒体, IP]` 会保存成对应类型。
- 卡片正面列表、普通摘要和引用摘要都不展示属性；列表卡片的卡背会只读展示属性。
- 全屏阅读底部展示“属性”折叠区，默认只读表格，点击编辑后可手动增删改。
- Markdown 导出时，有属性的 `.md` 文件会在开头写标准 YAML frontmatter；没有属性的笔记不输出空 frontmatter。
- 备份恢复仍以 `manifest.json` 里的 `metadata` 为事实源，不从 `.md` 文件反解析属性。

## 维护同步点

新增或修改笔记状态字段时，同时检查：

- `server/src/handlers/notes.rs`：`list`、`upsert`、`updateMany` 和删除清理。
- `server/src/handlers/common.rs`：接口返回 JSON。
- `server/src/handlers/backup.rs`：备份导出和恢复。
- `server/src/handlers/mcp.rs`：MCP 工具入参 schema。
- `app/src/store/blinkoraStore.tsx`：各页面列表筛选。
- `app/src/components/BlinkoraCard/index.tsx`：文章预览判定、全屏打开交互和普通卡片渲染分流。
- `app/src/components/BlinkoraCard/cardHeader.tsx`：卡片顶部区域、时间入口、操作按钮和三点菜单。
- `app/src/components/BlinkoraCard/CardBack.tsx`：列表卡背的人可读字段、自定义属性只读展示和内部字段隐藏。
- `app/src/components/BlinkoraCard/cardPreview.ts`：可读行解析、文章预览标题、引用预览文本和首行标题判断。
- `app/src/components/BlinkoraCard/noteContent.tsx`：普通短卡片 Markdown 渲染和排版状态 class。
- `app/src/components/BlinkoraCard/NotePropertiesPanel.tsx`：详情底部属性表格的展示、校验和保存。
- `app/src/hooks/useDragCard.tsx`：顶部/底部长按拖拽区域，改卡片顶部交互时必须确认不会破坏拖拽。
- `app/src/styles/github-markdown.css`：普通短卡片、全屏阅读和 Markdown 基础样式。
- `app/src/components/BlinkoraRightClickMenu/index.tsx`：右键菜单和三点菜单的类型转换入口。
- `app/src/components/Common/NoteTypePicker/index.tsx`：卡片左下角和编辑器里的类型选择器。
- `scripts/rust-smoke.mjs`：至少覆盖归档、归档列表可见、恢复。

## 验收

- 对普通闪念或笔记执行归档后，原列表不再显示，`/?path=archived` 可见。
- 在归档页恢复后，内容回到对应类型列表。
- 闪念、笔记、待办互转后，内容进入目标类型列表，原正文、标签和附件不变。
- 全局搜索可按需要跨普通区和归档区查询。
- 回收站内容不应出现在普通区或归档区。
- `bun run verify:rust` 通过。
