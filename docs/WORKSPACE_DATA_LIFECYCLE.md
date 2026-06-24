# Workspace 数据生命周期

本文档说明 Workspace 删除时会清理哪些数据，以及删除后怎么检查残留。

## 删除契约

入口：设置或顶部 Workspace 管理弹窗里的“删除工作区”。

后端过程：

- 默认 Workspace 禁止删除。
- 删除前先收集该 Workspace 的附件路径。
- 按附件路径删除物理文件：
  - `/api/file/...` 删除本地 `DATA_DIR/files` 下的文件。
  - `/api/s3file/...` 调用当前 S3 配置删除对象。
- 删除数据库记录：评论、历史、引用关系、标签关系、附件记录、标签、笔记、配置、工作区令牌和 Workspace 本身。

删除成功后，Blinkora 不再保留该 Workspace 的可见内容、关系边和附件记录。

## 卡片移动到其他 Workspace

入口：卡片右键菜单、卡片右上角三个点菜单，或多选栏里的“移动到”。

移动口径：

- 支持单张卡片移动，也支持在多选栏中批量移动。
- 回收站卡片不支持移动；归档卡片移动后仍保留归档状态。
- 移动会更新卡片、附件记录、评论、历史记录和标签关系的 Workspace 归属。
- 附件只改数据库归属，不复制、不删除本地文件或 S3 对象。
- 标签会按卡片正文中的 `#标签` 在目标 Workspace 重建，源 Workspace 中不再使用的标签会清理。
- 跨 Workspace 引用不保留；批量移动时所选卡片内部引用会保留，指向移动集合外的引用会删除，避免详情页出现“当前工作区找不到引用卡片”。

## 注意事项

- Workspace 删除是硬删除，不进回收站。
- S3 删除依赖删除时仍可用的全局 S3 配置和对象权限。
- 删除完成后，数据库里已经没有该 Workspace 的附件路径；要独立核验 S3 物理对象，只能用删除前记录的 key、对象存储访问日志，或在 S3 控制台按前缀搜索。
- 如果物理文件删除失败，后端会中止删除，不继续清业务数据库，避免留下“数据库没了但文件没删”的不确定状态。
- 单独删除卡片时，只有选择“连同资源删除”才会删除仅被这些卡片引用的附件对象。

## 残留检查

以下命令在 `docker/` 目录执行。若目标业务有多个名称或英文别名，按每个关键词分别执行。

先确认目标 Workspace 不存在：

```bash
docker compose exec -T db psql -U postgres -d postgres -c \
"SELECT id, name, description, \"isDefault\", \"createdAt\", \"updatedAt\"
 FROM workspaces
 WHERE name ILIKE '%关键词%' OR description ILIKE '%关键词%'
 ORDER BY id;"
```

检查核心表里是否还有业务关键词：

```bash
docker compose exec -T db psql -U postgres -d postgres -c \
"SELECT 'notes' AS table_name, COUNT(*) FROM notes
  WHERE content ILIKE '%关键词%' OR COALESCE(metadata::text,'') ILIKE '%关键词%'
 UNION ALL SELECT 'tag', COUNT(*) FROM tag
  WHERE name ILIKE '%关键词%'
 UNION ALL SELECT 'attachments', COUNT(*) FROM attachments
  WHERE name ILIKE '%关键词%' OR path ILIKE '%关键词%' OR COALESCE(metadata::text,'') ILIKE '%关键词%'
 UNION ALL SELECT 'comments', COUNT(*) FROM comments
  WHERE content ILIKE '%关键词%' OR COALESCE(metadata::text,'') ILIKE '%关键词%'
 UNION ALL SELECT 'noteHistory', COUNT(*) FROM \"noteHistory\"
  WHERE content ILIKE '%关键词%' OR COALESCE(metadata::text,'') ILIKE '%关键词%'
 UNION ALL SELECT 'config', COUNT(*) FROM config
  WHERE key ILIKE '%关键词%' OR COALESCE(config::text,'') ILIKE '%关键词%'
 UNION ALL SELECT 'agentAccessTokens', COUNT(*) FROM \"agentAccessTokens\"
  WHERE name ILIKE '%关键词%' OR COALESCE(permissions::text,'') ILIKE '%关键词%';"
```

检查是否有指向已删除 Workspace 的孤儿数据：

```bash
docker compose exec -T db psql -U postgres -d postgres -c \
"SELECT 'notes_orphan_workspace' AS check_name, COUNT(*) FROM notes n
  WHERE n.\"workspaceId\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=n.\"workspaceId\")
 UNION ALL SELECT 'tag_orphan_workspace', COUNT(*) FROM tag t
  WHERE t.\"workspaceId\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=t.\"workspaceId\")
 UNION ALL SELECT 'attachments_orphan_workspace', COUNT(*) FROM attachments a
  WHERE a.\"workspaceId\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=a.\"workspaceId\")
 UNION ALL SELECT 'comments_orphan_workspace', COUNT(*) FROM comments c
  WHERE c.\"workspaceId\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=c.\"workspaceId\")
 UNION ALL SELECT 'noteHistory_orphan_workspace', COUNT(*) FROM \"noteHistory\" h
  WHERE h.\"workspaceId\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=h.\"workspaceId\")
 UNION ALL SELECT 'config_orphan_workspace', COUNT(*) FROM config c
  WHERE c.\"workspaceId\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=c.\"workspaceId\")
 UNION ALL SELECT 'agent_tokens_orphan_workspace', COUNT(*) FROM \"agentAccessTokens\" t
  WHERE t.\"workspaceId\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=t.\"workspaceId\");"
```

检查关系表断链：

```bash
docker compose exec -T db psql -U postgres -d postgres -c \
"SELECT 'tagsToNote_orphan_note' AS check_name, COUNT(*) FROM \"tagsToNote\" ttn
  WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id=ttn.\"noteId\")
 UNION ALL SELECT 'tagsToNote_orphan_tag', COUNT(*) FROM \"tagsToNote\" ttn
  WHERE NOT EXISTS (SELECT 1 FROM tag t WHERE t.id=ttn.\"tagId\")
 UNION ALL SELECT 'noteReference_orphan_from', COUNT(*) FROM \"noteReference\" nr
  WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id=nr.\"fromNoteId\")
 UNION ALL SELECT 'noteReference_orphan_to', COUNT(*) FROM \"noteReference\" nr
  WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id=nr.\"toNoteId\");"
```

确认当前附件归属：

```bash
docker compose exec -T db psql -U postgres -d postgres -c \
"SELECT a.id, a.name, a.\"workspaceId\", w.name AS workspace_name, a.\"noteId\", left(a.path, 120) AS path_preview
 FROM attachments a
 LEFT JOIN workspaces w ON w.id=a.\"workspaceId\"
 ORDER BY a.id;"
```

## 通过口径

- 目标 Workspace 查询结果为 0 行。
- 核心表关键词命中为 0。
- Workspace、标签关系、引用关系没有 orphan 记录。
- 剩余附件都归属于现存 Workspace。
- 本地 `docker/data/blinkora` 或 `~/.blinkora/local/data` 下没有目标业务关键词文件名。
