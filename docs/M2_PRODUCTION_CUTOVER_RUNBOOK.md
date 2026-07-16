# M2 生产切换运行手册

适用范围：飞牛 PostgreSQL 主服务迁移到 macOS 本机 SQLite。飞牛只保留 PostgreSQL 与原附件作为回滚源，不部署 SQLite。

## 已确认的服务拓扑

| 项目 | 值 |
| --- | --- |
| 飞牛主机 | `192.168.2.25` |
| Web/MCP/Agent unit | `blinkora.service` |
| PostgreSQL unit | `blinkora-db.service` |
| Web 工作目录 | `/vol1/1000/docker/blinkora/local` |
| Web 环境文件 | `/vol1/1000/docker/blinkora/local/blinkora.env` |
| PostgreSQL 工作目录 | `/vol1/1000/docker/blinkora/compose` |
| 本机 unit | `com.blinkora.local` |
| 本机应用目录 | `~/.blinkora/local` |
| 本机正式数据目录 | `~/.blinkora/local/data` |

停止 `blinkora.service` 会关闭 Web、REST、tRPC、MCP 和 Agent 写入口；`blinkora-db.service` 必须继续运行到最终快照完成。不得停止、重建或删除 PostgreSQL 容器。

## 授权门槛

执行前记录以下信息：

- 维护窗口开始与最晚结束时间；
- 允许停止和启动 `blinkora.service`；
- 允许在飞牛用户目录创建只读快照文件并复制到本机；
- 允许替换本机 `~/.blinkora/local/data`；
- 主服务切换成功条件和回滚决定人；
- 是否授权按数据库中的 8 个已知 S3 key 只读校验。未授权时不得列举、读取、写入或删除这些业务对象，该项必须在报告中保持待验。

缺任一授权时，只能执行维护窗口前的只读检查。

## 维护窗口前检查

```bash
git status --short
git rev-parse HEAD
bun run verify:rust
bun run build:web --force
bun run smoke:m2-clone
```

S3 凭据通过受限环境注入，不写入 shell 历史或报告。父前缀只使用新名称，不得包含 `blinkora` 或 `blinkora_local`：

```bash
BLINKORA_S3_SMOKE_CUSTOM_PATH='codex-m2-preflight-<日期>' \
bun run smoke:s3-local
```

确认两端仍健康：

```bash
curl -fsS http://192.168.2.25:6676/health
curl -fsS http://127.0.0.1:6676/health
```

## 阶段 1：停写与最终快照

在飞牛执行：

```bash
sudo systemctl stop blinkora.service
systemctl is-active blinkora.service
systemctl is-active blinkora-db.service
```

预期：`blinkora.service=inactive`，`blinkora-db.service=active`。若 Web 仍可写，立即中止。

创建权限受限的远端快照目录，并从 unit 环境文件加载连接信息；不要输出环境变量：

```bash
RUN_ID="m2-final-$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE_RUN="$HOME/.blinkora-migration/$RUN_ID"
umask 077
mkdir -p "$REMOTE_RUN"
set -a
source /vol1/1000/docker/blinkora/local/blinkora.env
set +a

pg_dump --format=custom \
  --file="$REMOTE_RUN/blinkora-postgres.dump" \
  "$DATABASE_URL"
pg_restore --list "$REMOTE_RUN/blinkora-postgres.dump" >/dev/null
tar -cf "$REMOTE_RUN/files.tar" -C "$DATA_DIR" files
printf 'BLINKORA_SECRET=%s\n' "$BLINKORA_SECRET" \
  >"$REMOTE_RUN/blinkora-secret.env"
sha256sum \
  "$REMOTE_RUN/blinkora-postgres.dump" \
  "$REMOTE_RUN/files.tar" \
  "$REMOTE_RUN/blinkora-secret.env" \
  >"$REMOTE_RUN/SHA256SUMS"
chmod 600 "$REMOTE_RUN"/*
```

快照完成前不得启动 `blinkora.service`。快照失败时删除不完整临时文件，启动源服务并结束窗口。

## 阶段 2：本机迁移候选

将 `blinkora-postgres.dump`、`files.tar`、`blinkora-secret.env` 和 `SHA256SUMS` 复制到本机权限为 `0700` 的新运行目录。复制后执行 SHA-256 校验，不要输出环境文件内容。用 `cmp` 比较远端 secret sidecar 与本机环境中的 `BLINKORA_SECRET` 行；不一致时必须先安全更新本机 sidecar，再启动候选。

把快照恢复到本机隔离 PostgreSQL。先创建空候选目录并恢复完整 `files/`，再让迁移工具只连接隔离 PostgreSQL：

```bash
CANDIDATE_DIR="$HOME/.blinkora/local/data.m2-candidate-$RUN_ID"
mkdir -m 700 "$CANDIDATE_DIR"
tar -xf "$HOME/.blinkora/migrations/$RUN_ID/files.tar" -C "$CANDIDATE_DIR"

BLINKORA_POSTGRES_URL='<本机隔离 PostgreSQL 连接串>' \
bun run migrate:postgres-to-sqlite -- \
  --data-dir "$CANDIDATE_DIR" \
  --snapshot-dir "$HOME/.blinkora/migrations/$RUN_ID/tool-snapshots"
```

候选目录必须与正式数据目录位于同一文件系统。迁移日志只保留阶段、计数和哈希。

校验候选：

```bash
CANDIDATE="$HOME/.blinkora/local/data.m2-candidate-$RUN_ID/blinkora.sqlite3"
sqlite3 "$CANDIDATE" 'PRAGMA integrity_check;'
sqlite3 "$CANDIDATE" 'SELECT COUNT(*) FROM pragma_foreign_key_check;'
```

逐表比较 14 张表的行数、最大 ID 和规范化 SHA-256。字体 BLOB、本地附件和迁移快照按 SHA-256 比较；任何差异都中止切换。

## 阶段 3：本机激活

停止本机服务，备份数据库、附件和环境 sidecar：

```bash
bun run deploy:local stop
bash scripts/sqlite-backup.sh --offline \
  --data-dir "$HOME/.blinkora/local/data" \
  --output "$HOME/.blinkora/migrations/$RUN_ID/pre-activation-backup"
cp "$HOME/.blinkora/local/blinkora.env" \
  "$HOME/.blinkora/migrations/$RUN_ID/pre-activation-backup/blinkora.env"
chmod 600 "$HOME/.blinkora/migrations/$RUN_ID/pre-activation-backup/blinkora.env"
```

保留现有数据目录作为同盘回滚点，再激活候选：

```bash
mv "$HOME/.blinkora/local/data" \
  "$HOME/.blinkora/local/data.pre-$RUN_ID"
mv "$HOME/.blinkora/local/data.m2-candidate-$RUN_ID" \
  "$HOME/.blinkora/local/data"
bun run deploy:local start
curl -fsS http://127.0.0.1:6676/health
```

第二次 `mv` 或启动失败时，不得继续验收；立即执行回滚。

## 阶段 4：切换验收

只读检查：

- 原账号登录；
- 原账号 API token；
- 未撤销 Workspace token；
- 5 个 Workspace、历史、引用、评论、日志、配置和字体；
- 14 表行数、最大 ID、规范化哈希；
- `integrity_check=ok`、外键和 orphan 为 0。

最小写入只在新建 Workspace 中执行。附件使用全新 S3 前缀；浏览器首次加载前必须锁定该 Workspace，避免请求旧附件。验收完成后删除测试 Workspace 和已知测试对象，不列举 Bucket。

再次停止本机服务，运行物理备份并恢复到空目录。恢复包必须包含 `blinkora.env` sidecar；恢复实例需再次通过账号 API token、Workspace token、健康和完整性检查。

## 回滚

任一条件触发回滚：

- 14 表计数或规范化哈希不一致；
- 账号、API token 或 Workspace token 失效；
- SQLite 完整性、外键或 orphan 检查失败；
- 非预期 4xx/5xx、`database is locked`、附件丢失或写事务不完整；
- 本机服务在 30 秒内未健康；
- 维护窗口达到预定截止时间。

本机回滚：

```bash
bun run deploy:local stop
mv "$HOME/.blinkora/local/data" \
  "$HOME/.blinkora/local/data.failed-$RUN_ID"
mv "$HOME/.blinkora/local/data.pre-$RUN_ID" \
  "$HOME/.blinkora/local/data"
bun run deploy:local start
curl -fsS http://127.0.0.1:6676/health
```

随后在飞牛执行：

```bash
sudo systemctl start blinkora.service
systemctl is-active blinkora.service
curl -fsS http://127.0.0.1:6676/health
```

回滚期间不得把 SQLite 测试写入反向同步到 PostgreSQL。

## 完成条件

所有门禁通过后，飞牛 `blinkora.service` 保持停止，`blinkora-db.service` 和原始快照继续保留；本机成为主服务。保留最终快照、切换前备份、环境 sidecar、失败记录和回滚目录，直到用户另行授权清理。
