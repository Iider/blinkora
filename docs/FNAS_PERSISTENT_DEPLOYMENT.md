# 飞牛常驻部署

飞牛上的 Blinkora 以一个 Rust systemd 服务运行，数据使用本机文件系统上的 SQLite。SQLite 不支持多副本服务、NFS 或 SMB 数据目录。

当前正式 SQLite 服务刻意使用新的名称和目录，不会复用旧 PostgreSQL 安装：

| 内容 | SQLite 正式位置 |
| --- | --- |
| systemd 服务 | `blinkora-sqlite.service` |
| 运行目录 | `/vol1/1000/docker/blinkora-sqlite/local` |
| SQLite 与本地附件 | `/vol1/1000/docker/blinkora-sqlite/data/app` |
| 迁移前 Mac 快照 | `/vol1/1000/docker/blinkora-sqlite/backups/macos-snapshot-<timestamp>` |
| 服务账号 | `weio:Users` |

旧安装 `/vol1/1000/docker/blinkora` 以及旧的 `blinkora.service` 不应被删除或复用。切换后旧服务处于停用状态，旧目录及其中的 PostgreSQL 数据保留，便于有需要时回退。

`blinkora.env`、SQLite 数据库和物理备份都包含认证数据、令牌和存储凭据；运行和数据目录应为 `0700`，数据库、环境文件和备份中的普通文件应为 `0600`。不要把它们复制到命令历史、聊天记录或 Git。

## 安装或更新运行时

开发机先构建 x86_64 Linux release：

```bash
TARGETARCH=amd64 DOCKER_DEFAULT_PLATFORM=linux/amd64 \
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:rust-release
```

将 `release/rust/`、`deploy/fnas/blinkora-sqlite.service` 和受限权限的 `blinkora.env` 上传到飞牛临时目录。生产路径已经有数据时，更新只允许替换 `local/bin/blinkora-server`、`local/public/` 和 `local/db/schema.sqlite.sql`；不得重建或覆盖 `data/app`。

环境文件的最小内容如下；`BLINKORA_SECRET` 必须使用已有服务的随机值或新生成的 32 字节随机值，绝不能填写示例文本。

```dotenv
NODE_ENV=production
BIND_ADDR=0.0.0.0
PORT=6676
PUBLIC_PATH=/vol1/1000/docker/blinkora-sqlite/local/public
DATA_DIR=/vol1/1000/docker/blinkora-sqlite/data/app
SCHEMA_PATH=/vol1/1000/docker/blinkora-sqlite/local/db/schema.sqlite.sql
BLINKORA_SECRET=<随机值>
RUST_LOG=info
```

安装 unit：

```bash
sudo install -m 0644 deploy/fnas/blinkora-sqlite.service \
  /etc/systemd/system/blinkora-sqlite.service
sudo systemctl daemon-reload
sudo systemctl enable --now blinkora-sqlite.service
```

仓库中的 unit 固定匹配上述路径和 `weio:Users`。如果迁移到另一台 NAS 或更换服务账号，必须一起修改 unit、环境文件和目录属主；不能只改其中一项。

提交前可执行 `bun run verify:fnas-sqlite-systemd` 检查模板中的 section、账号和路径。它只验证仓库文件，不能替代飞牛实机检查。

## 日常检查与更新

```bash
sudo systemctl status --no-pager blinkora-sqlite.service
curl -fsS http://127.0.0.1:6676/health
sudo journalctl -u blinkora-sqlite.service -n 80 --no-pager
```

SQLite 完整性检查可在飞牛预装的 Python 3 上完成，不依赖 `sqlite3` 命令行工具：

```bash
python3 - <<'PY'
import sqlite3
db = '/vol1/1000/docker/blinkora-sqlite/data/app/blinkora.sqlite3'
with sqlite3.connect(db) as conn:
    assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not conn.execute('PRAGMA foreign_key_check').fetchall()
print('SQLite integrity and foreign keys: ok')
PY
```

更新前先停止服务并为当前运行时生成可回退副本，再替换 release 文件并启动服务。`DATA_DIR` 不参与更新；完成后至少检查健康接口、登录与附件读取。

```bash
sudo systemctl stop blinkora-sqlite.service
# 在同一文件系统备份并替换 local/bin、local/public、local/db
sudo systemctl start blinkora-sqlite.service
```

## 物理备份与回退

物理备份必须在服务完全停止后进行，数据库使用 SQLite `.backup`，附件同时复制。仓库的 `scripts/sqlite-backup.sh` 和 `scripts/sqlite-restore.sh` 需要 `sqlite3` 命令行工具；飞牛默认只有 Python 时，先安装 SQLite CLI，或由可信运维环境执行备份并写入 `/vol1/1000/docker/blinkora-sqlite/backups`。

要回退到旧 PostgreSQL 版本，先停用 SQLite unit，再重新启用旧 unit；不要删除 SQLite 目录，保留它供调查和再次迁移：

```bash
sudo systemctl disable --now blinkora-sqlite.service
sudo systemctl enable --now blinkora.service
```

这只切换服务角色，不会更改 `/vol1/1000/docker/blinkora` 或 `/vol1/1000/docker/blinkora-sqlite` 内的任一数据文件。
