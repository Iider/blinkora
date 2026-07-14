# 本机持久化部署

这个模式直接在 macOS 上用 `launchd` 运行 Blinkora，不需要 Docker。SQLite、附件和运行配置都放在用户目录，重启、升级和卸载服务都不会删除数据。

- 数据目录：`~/.blinkora/local/data`（含 `blinkora.sqlite3` 与 `files/`）
- 服务配置：`~/.blinkora/local/blinkora.env`，权限为 `0600`
- 服务日志：`~/.blinkora/local/logs`
- 访问地址：`http://localhost:6676`

## 前置条件

- Bun：构建前端资源。
- Rust toolchain：编译 macOS 本机 `blinkora-server`。

## 安装与更新

```bash
bun run deploy:local install
# 代码更新后
bun run deploy:local update
```

安装脚本会构建前端和本机 release、生成随机 `BLINKORA_SECRET`、写入受限权限的环境文件，并安装 `com.blinkora.local`。首次启动会在 `DATA_DIR` 创建 SQLite schema；已有库会先做版本和完整性探针，不会覆盖非空未知数据库。

## 日常命令

```bash
bun run deploy:local status
bun run deploy:local logs
bun run deploy:local restart
bun run deploy:local stop
bun run deploy:local start
bun run deploy:local uninstall
```

`uninstall` 只移除 `launchd` 服务，保留全部数据。

## 验收与排障

```bash
curl -fsS http://127.0.0.1:6676/health
sqlite3 ~/.blinkora/local/data/blinkora.sqlite3 'PRAGMA integrity_check;'
sqlite3 ~/.blinkora/local/data/blinkora.sqlite3 'SELECT COUNT(*) FROM pragma_foreign_key_check;'
```

健康接口仅在 SQLite 已打开、schema 已完成且探针成功时返回 `200`。页面打不开时先检查 `bun run deploy:local status`、端口监听和 `~/.blinkora/local/logs/blinkora.err.log`。若数据目录只读、磁盘空间不足、数据库损坏或 schema 版本过新，服务会拒绝提供健康状态；先保留原文件，再根据错误恢复。

## 物理备份与恢复

先停止服务，再执行：

```bash
bun run deploy:local stop
scripts/sqlite-backup.sh --offline \
  --data-dir ~/.blinkora/local/data \
  --output ~/BlinkoraBackups/20260714
```

该命令用 SQLite `.backup` 生成一致数据库快照，并在服务停写时一并复制附件；不能只复制 `blinkora.sqlite3` 主文件。恢复时必须使用空数据目录：

```bash
scripts/sqlite-restore.sh \
  --backup ~/BlinkoraBackups/20260714 \
  --data-dir ~/.blinkora/local/data-restored
```

恢复后启动 Blinkora，完成登录、附件读取和健康检查，再切换正式数据目录。
