# 飞牛常驻部署

Blinkora 在飞牛上以单个 Rust 服务运行，SQLite 与附件使用本地磁盘。SQLite 不支持多副本服务、NFS 或 SMB 数据目录。

## 运行结构

- 服务：systemd `blinkora.service`
- Rust 二进制：`/vol1/1000/docker/blinkora/local/bin/blinkora-server`
- 前端静态资源：`/vol1/1000/docker/blinkora/local/public`
- schema：`/vol1/1000/docker/blinkora/local/db/schema.sqlite.sql`
- 运行配置：`/vol1/1000/docker/blinkora/local/blinkora.env`
- SQLite 与附件：`/vol1/1000/docker/blinkora/data/app`
- 发布备份：`/vol1/1000/docker/blinkora/backups`

`blinkora.env` 和 SQLite 文件包含认证数据、令牌和存储凭据；目录应为 `0700`，数据库和备份文件应为 `0600`，不要复制到命令历史或提交记录。

## 日常检查

```bash
systemctl status blinkora.service
curl -fsS http://127.0.0.1:6676/health
sqlite3 /vol1/1000/docker/blinkora/data/app/blinkora.sqlite3 'PRAGMA integrity_check;'
sqlite3 /vol1/1000/docker/blinkora/data/app/blinkora.sqlite3 'SELECT COUNT(*) FROM pragma_foreign_key_check;'
```

## 发布更新

开发机生成 Linux release：

```bash
TARGETARCH=amd64 DOCKER_DEFAULT_PLATFORM=linux/amd64 \
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:rust-release
```

只替换 `release/rust/blinkora-server`、`release/rust/public/` 和 `release/rust/db/schema.sqlite.sql`。先将旧 release 放进同一文件系统内的发布备份，再原子替换并重启 `blinkora.service`。不要删除或重建数据目录。

## 物理备份

停止服务后，运行仓库内的 `scripts/sqlite-backup.sh --offline`，把 `DATA_DIR` 指向 `/vol1/1000/docker/blinkora/data/app`。恢复到空目录后，先完成健康检查、登录和附件读取 smoke，再替换正式数据目录。
