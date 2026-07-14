# 旧安装迁移到 SQLite

这份文档只服务于一次性迁移。正式运行时不包含 PostgreSQL 驱动、连接配置或专用 SQL；旧 schema 快照仅保存在 `tools/postgres-to-sqlite/postgres-schema.sql`，供迁移校验使用。

## 前提

- 迁移期间停止 Blinkora 写入，并保留原数据目录与 PostgreSQL 实例。
- 安装 `pg_dump`、Rust toolchain 和 SQLite CLI。
- `DATA_DIR` 必须是现有附件目录；其中不能已有 `blinkora.sqlite3`。
- SQLite 只支持一个 Blinkora 服务进程和本地文件系统，不支持 NFS、SMB 或多副本运行。

## 执行

```bash
BLINKORA_POSTGRES_URL='<旧库连接串>' \
bun run migrate:postgres-to-sqlite -- \
  --data-dir '<现有 DATA_DIR>' \
  --snapshot-dir '<受限权限的快照目录>'
```

工具先用可重复读事务锁住 14 张源表的写入，再创建 PostgreSQL 自定义格式快照；随后在临时 SQLite 文件中导入并逐表校验。校验包含行数、规范化行 SHA-256、JSON 键序、字体 BLOB、SQLite 完整性与外键检查。只有全部成功才原子改名为 `DATA_DIR/blinkora.sqlite3`。源库和快照不会自动删除，日志只输出阶段、行数和哈希，不输出密码、令牌或存储密钥。

本地附件沿用原 `DATA_DIR/files`，工具会验证每条本地附件记录的文件存在性和汇总 SHA-256；S3 对象不复制，继续由原 S3 配置引用。

## 迁移后验证

```bash
sqlite3 '<DATA_DIR>/blinkora.sqlite3' 'PRAGMA integrity_check;'
sqlite3 '<DATA_DIR>/blinkora.sqlite3' 'SELECT COUNT(*) FROM pragma_foreign_key_check;'
```

然后启动 SQLite 版本，使用原账号、账号 API token 和未撤销工作区 token 完成登录、字体读取、S3 校验、历史、引用、评论与 MCP smoke。新建记录的 ID 必须大于迁移前该表的最大 ID。

## 双后端差分

在隔离夹具上同时启动迁移前 PostgreSQL 服务和迁移后的 SQLite 服务后，执行：

```bash
BLINKORA_POSTGRES_BASE_URL='http://127.0.0.1:16676' \
BLINKORA_SQLITE_BASE_URL='http://127.0.0.1:16678' \
BLINKORA_SMOKE_USER='<夹具账号>' \
BLINKORA_SMOKE_PASSWORD='<夹具密码>' \
BLINKORA_CONTRACT_REPORT_PATH='/受限目录/contract.json' \
bun run test:postgres-sqlite-contract
```

脚本从当前服务端注册表读取全部 74 个 procedure，拒绝数量漂移；确定性读接口逐值比较，原本无排序约束的列表按成员集合比较，随机和写入接口比较 HTTP/tRPC envelope、业务错误和返回结构。它还比较 `/health`、认证资料、同一路径附件内容和 MCP `tools/list`。报告不写入 token 或密码。

## 同机 p95 对比

在同一固定夹具、同一台机器上，启动 PostgreSQL 基线和刚迁移的 SQLite 候选后执行：

```bash
BLINKORA_POSTGRES_BASE_URL='http://127.0.0.1:16676' \
BLINKORA_SQLITE_BASE_URL='http://127.0.0.1:16678' \
BLINKORA_SMOKE_USER='<夹具账号>' \
BLINKORA_SMOKE_PASSWORD='<夹具密码>' \
BLINKORA_PERF_REPORT_PATH='/受限目录/performance.json' \
bun run test:postgres-sqlite-performance
```

脚本交替预热并分别采样列表、详情、子串搜索和写入，逐项计算 p95；SQLite 任一 p95 超过 PostgreSQL 的 120% 会以非零状态退出。默认采样 100 次，`BLINKORA_PERF_SAMPLES` 可增加样本量。

## 回滚演练

1. 停止 SQLite 服务，保留 `blinkora.sqlite3` 供排查。
2. 让原服务继续使用保留的 PostgreSQL 数据与附件目录。
3. 从迁移前快照恢复到隔离环境，确认可登录和读取附件。
4. 只有完成问题修复并重新全量校验后，才再次执行迁移。

不要用 `blinkora.backup.v1` 替代数据库迁移：该格式不是所有账号、字体、令牌和运行配置的物理全量快照。
