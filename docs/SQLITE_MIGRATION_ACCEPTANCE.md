# SQLite 替换验收记录

这份记录只记已经实际执行的证据；没有执行的项目明确标为待验，不以“可编译”代替验收。

## 本次候选

- 基线提交：`f061365fa802e63ccbe1090aa9c0c837b8064057`（迁移前运行时）。
- 候选提交：`5991026`（SQLite 运行时替换实现）。
- 平台：macOS arm64，本地文件系统，Rust 1.96，SQLite CLI 3.x。
- 数据规模：真实接口 smoke；2,000 条批量笔记；10 客户端短跑并发；物理备份/空目录恢复。

## 已通过

| 项目 | 证据 |
| --- | --- |
| SQLite 初始化与升级保护 | Rust 集成测试覆盖空库、重复启动、WAL、外键、5 秒 busy timeout、`FULL` 同步、JSON 语义、事务回滚与 2,100 ID JSON 绑定。 |
| 事务与并发 | 单进程写门控覆盖 tRPC、MCP 转发、备份导入和文件写入；10 客户端短跑实际完成 1,740 次混合写入，历史版本连续。完整 300 秒脚本见 `scripts/sqlite-concurrency.mjs`。 |
| 2,000 ID 批量路径 | `bun run test:sqlite-bulk` 实测 2,000 条记录的更新、跨 Workspace 移动、导出与删除。 |
| 接口 smoke | `smoke:rust` 和 `smoke:agent` 均在恢复后的 SQLite 数据目录通过。覆盖登录、Workspace、笔记、历史、标签、评论、附件、导入导出、MCP 和 Agent token。 |
| 物理备份 | `sqlite-backup.sh --offline` 后用 `sqlite-restore.sh` 恢复到空目录；恢复库健康检查、完整 smoke、`integrity_check` 与 `foreign_key_check` 均通过。 |
| 完整性 | 恢复测试库的 `integrity_check=ok`，外键、Workspace、标签关系、引用和评论 orphan 均为 0。 |
| 构建 | `bun run build:web --force`、`bun run verify:rust`、macOS 原生 `cargo build --release --locked --manifest-path server/Cargo.toml` 通过。 |

## 待验 / 阻断发布

- 此环境没有可用 PostgreSQL 服务或 Docker 守护进程，无法实际执行源库无损迁移、PostgreSQL/SQLite 双后端 74 procedure 差分、真实回滚演练和同机性能基线对比。
- 未提供真实 S3 验证凭据，因此真实 S3 附件 smoke 未执行；本地存储 smoke 已通过。
- 终端执行器会在约 30 秒终止长任务，不能在这里取得完整 5 分钟压测结果；可在目标机直接执行默认 300 秒的 `scripts/sqlite-concurrency.mjs`。
- Linux amd64/arm64 Docker release 未构建：此 macOS 环境没有 Rust Linux target 管理器，Docker 守护进程也不可用。macOS 原生 release 已通过。

在以上项目补齐并记录结果前，本次不能标记为“全部验收通过”。
