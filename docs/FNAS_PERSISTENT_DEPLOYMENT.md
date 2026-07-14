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

## 首次安装

以下命令以独立的 `blinkora` 服务账号为例；路径必须位于飞牛本机磁盘，不能是 NFS 或 SMB 挂载。开发机先执行 `bun run build:rust-release`，将 `release/rust/` 与 `deploy/fnas/blinkora.service` 一起传到飞牛的临时发布目录，并保留相对路径；在该目录中执行下面的文件安装命令。

```bash
install -d -o blinkora -g blinkora -m 0700 \
  /vol1/1000/docker/blinkora/local/{bin,public,db} \
  /vol1/1000/docker/blinkora/data/app \
  /vol1/1000/docker/blinkora/backups
install -o blinkora -g blinkora -m 0755 release/rust/blinkora-server \
  /vol1/1000/docker/blinkora/local/bin/blinkora-server
cp -a release/rust/public/. /vol1/1000/docker/blinkora/local/public/
chown -R blinkora:blinkora /vol1/1000/docker/blinkora/local/public
install -o blinkora -g blinkora -m 0600 release/rust/db/schema.sqlite.sql \
  /vol1/1000/docker/blinkora/local/db/schema.sqlite.sql
```

创建 `/vol1/1000/docker/blinkora/local/blinkora.env`，权限必须是 `0600`、属主为 `blinkora`：

```dotenv
NODE_ENV=production
PORT=6676
PUBLIC_PATH=/vol1/1000/docker/blinkora/local/public
DATA_DIR=/vol1/1000/docker/blinkora/data/app
SCHEMA_PATH=/vol1/1000/docker/blinkora/local/db/schema.sqlite.sql
BLINKORA_SECRET=<用 openssl rand -hex 32 生成的随机值>
RUST_LOG=info
```

先用 `install -o blinkora -g blinkora -m 0600 /dev/null /vol1/1000/docker/blinkora/local/blinkora.env` 创建该文件，再写入实际的随机密钥；不要保留示例中的 `<...>`。

安装仓库中的 systemd unit：

```bash
install -m 0644 deploy/fnas/blinkora.service /etc/systemd/system/blinkora.service
```

模板默认使用本节的 `blinkora` 服务账号和 `/vol1/1000/docker/blinkora` 路径；改动账号或目录时，必须同步修改 unit、`blinkora.env` 和目录属主。

开发机可运行 `bun run verify:fnas-systemd`，校验 unit 的 section、关键值、服务账号与运行路径。该命令只验证部署定义，不能替代飞牛实机验收。

最后启用服务：

```bash
systemctl daemon-reload
systemctl enable --now blinkora.service
```

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

只替换 `local/bin/blinkora-server`、`local/public/` 和 `local/db/schema.sqlite.sql`。先停止服务、将旧发布文件放入同一文件系统内的发布备份，再替换发布文件并重启 `blinkora.service`。不要删除或重建数据目录。完成后至少执行健康检查、登录和附件读取 smoke。

```bash
systemctl stop blinkora.service
# 在同一文件系统完成发布文件替换；DATA_DIR 不参与替换
systemctl start blinkora.service
systemctl status --no-pager blinkora.service
```

## 停止与卸载

```bash
systemctl disable --now blinkora.service
rm -f /etc/systemd/system/blinkora.service
systemctl daemon-reload
```

这只移除服务定义；`data/app`、SQLite、附件和发布备份必须保留，确认恢复演练完成后才能人工清理。

## 物理备份

停止服务后，运行仓库内的 `scripts/sqlite-backup.sh --offline`，把 `DATA_DIR` 指向 `/vol1/1000/docker/blinkora/data/app`。恢复到空目录后，先完成健康检查、登录和附件读取 smoke，再替换正式数据目录。
