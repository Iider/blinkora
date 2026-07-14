# Workspace 数据生命周期

本文档说明 Workspace 删除和笔记跨 Workspace 移动的清理契约，并给出 SQLite 残留检查。

## 删除契约

- 默认 Workspace 禁止删除。
- 删除前先收集附件路径；本地 `/api/file/...` 删除 `DATA_DIR/files` 对应文件，S3 路径调用当前 S3 配置删除对象。
- 同一事务内删除评论、历史、引用、标签关系、附件记录、标签、笔记、配置、工作区令牌和 Workspace。
- 物理文件删除失败时中止操作，不继续删除数据库记录。

## 跨 Workspace 移动

- 支持单张和批量移动，回收站卡片不支持移动。
- 移动会更新笔记、附件记录、评论、历史和标签关系的 Workspace；附件文件和 S3 对象不会复制。
- 目标 Workspace 按笔记正文 hashtag 重建标签；跨 Workspace 引用不会保留，批量集合内部引用保留。

## 残留检查

以下命令以 `DATA_DIR` 为当前运行数据目录。将“关键词”替换为待检查文本。

```bash
sqlite3 "$DATA_DIR/blinkora.sqlite3" <<'SQL'
SELECT id, name, description, "isDefault"
FROM workspaces
WHERE name LIKE '%关键词%' OR description LIKE '%关键词%'
ORDER BY id;

SELECT 'notes' AS table_name, COUNT(*) FROM notes
 WHERE content LIKE '%关键词%' OR COALESCE(metadata, '') LIKE '%关键词%'
UNION ALL SELECT 'tag', COUNT(*) FROM tag WHERE name LIKE '%关键词%'
UNION ALL SELECT 'attachments', COUNT(*) FROM attachments
 WHERE name LIKE '%关键词%' OR path LIKE '%关键词%' OR COALESCE(metadata, '') LIKE '%关键词%'
UNION ALL SELECT 'comments', COUNT(*) FROM comments
 WHERE content LIKE '%关键词%' OR COALESCE(metadata, '') LIKE '%关键词%';

SELECT 'foreign_key_violations', COUNT(*) FROM pragma_foreign_key_check;
SELECT 'tags_to_note_orphans', COUNT(*) FROM "tagsToNote" t
 WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id=t."noteId")
    OR NOT EXISTS (SELECT 1 FROM tag g WHERE g.id=t."tagId");
SELECT 'reference_orphans', COUNT(*) FROM "noteReference" r
 WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id=r."fromNoteId")
    OR NOT EXISTS (SELECT 1 FROM notes n WHERE n.id=r."toNoteId");
SQL
```

通过口径：目标 Workspace 与关键词记录均不再出现，外键和关系 orphan 均为 `0`，并且 `PRAGMA integrity_check` 返回 `ok`。
