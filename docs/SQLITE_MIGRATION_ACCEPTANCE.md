# SQLite 替换验收记录

这份记录只记已经实际执行的证据；没有执行的项目明确标为待验，不以“可编译”代替验收。

## 本次候选

- 基线提交：`f061365fa802e63ccbe1090aa9c0c837b8064057`（迁移前运行时）。
- 候选提交：`5991026`（SQLite 运行时替换实现）。
- 平台：macOS arm64、本地文件系统、OrbStack Docker、PostgreSQL 14.23、SQLite CLI 3.x、Rust 1.96。
- 数据规模：真实接口 smoke；2,000 条批量笔记；10 客户端 300 秒并发；物理备份/空目录恢复；PostgreSQL 真实迁移夹具。

## 已通过

| 项目 | 证据 |
| --- | --- |
| SQLite 初始化与升级保护 | Rust 集成测试覆盖空库、重复启动、WAL、外键、5 秒 busy timeout、`FULL` 同步、JSON 语义、事务回滚与 2,100 ID JSON 绑定。 |
| 事务与并发 | 单进程写门控覆盖 tRPC、MCP 转发、备份导入和文件写入；10 客户端实际持续 300 秒，完成 2,970 次写入和 990 次读取，种子笔记历史版本连续 990 条；无 `database is locked`、非预期 5xx 或 orphan。完整脚本见 `scripts/sqlite-concurrency.mjs`。 |
| 2,000 ID 批量路径 | `bun run test:sqlite-bulk` 实测 2,000 条记录的更新、跨 Workspace 移动、导出与删除。 |
| 接口 smoke | `smoke:rust` 和 `smoke:agent` 均在恢复后的 SQLite 数据目录通过。另以 MinIO 启动真实 S3-compatible 服务完成 `smoke:rust` 的 S3 分支（配置校验、上传、读取、移动、删除、目录删除与切回本地存储）。覆盖登录、Workspace、笔记、历史、标签、评论、附件、导入导出、MCP 和 Agent token。 |
| 双后端差分 | 同一 PostgreSQL 夹具迁移到隔离 SQLite 后，`test:postgres-sqlite-contract` 覆盖注册表中的 74/74 procedure：19 项确定性结果逐值相等、3 项原本未排序列表按集合相等、36 项随机/写入返回结构相等、16 项业务错误 envelope 相等；`/health`、认证资料、附件下载 SHA-256 与 MCP `tools/list` 也相等。 |
| 真实无损迁移 | PostgreSQL 14.23 实际迁移，14 张表逐表行数与规范化 SHA-256 均相等；最终夹具包含账号、Workspace、笔记、标签关系、附件、历史、引用、评论、配置、字体 BLOB、工作区令牌、操作日志与 cache。迁移保留快照，目标在临时 SQLite 文件验证后原子切换。 |
| 迁移后凭据与序列 | 使用迁移前 API token、未撤销 Workspace token 和字体 BLOB 直接访问 SQLite 成功；新建笔记、字体和 Agent token ID 分别为 32、4、8，均大于迁移前最大 ID 31、3、7。 |
| 回滚演练 | 停止 SQLite 后重新启动原 PostgreSQL 服务并用原账号登录成功；原 PostgreSQL 实例和数据未被迁移工具删除或改写。 |
| 物理备份 | `sqlite-backup.sh --offline` 后用 `sqlite-restore.sh` 恢复到空目录；恢复库健康检查、完整 smoke、`integrity_check` 与 `foreign_key_check` 均通过。 |
| 完整性 | 恢复测试库的 `integrity_check=ok`，外键、Workspace、标签关系、引用和评论 orphan 均为 0。 |
| 异常启动拒绝 | 损坏 SQLite 页启动时报完整性错误；只读 bind mount 报 `Read-only file system`；32 KiB tmpfs 报磁盘 I/O 错误，三者均以非零退出且未返回健康。未来 schema 版本由 Rust 集成测试覆盖并明确拒绝。 |
| 强制终止恢复 | 在 20,000 个 hashtag 的笔记写入/标签同步请求中对服务发送 `SIGKILL`，客户端请求失败。重启后健康检查正常，`integrity_check=ok`、外键检查为 0，写入中的笔记、标签关系和标签均为 0 条，未出现半写。 |
| 同机 p95 性能 | 同一 macOS arm64 主机、同一迁移夹具、PostgreSQL 与 SQLite macOS release 二进制各采样 100 次、预热 20 次：SQLite/PG p95 为列表 27.6%（2.604/9.446 ms）、详情 36.5%（2.470/6.770 ms）、子串搜索 40.0%（3.014/7.540 ms）、写入 21.8%（3.290/15.091 ms），均低于 120% 门槛。 |
| 导入导出性能 | 同机 release 夹具执行 Workspace/full × Markdown/JSON 各 5 次；每次导入后删除导入 Workspace，双方都回到 2 个 Workspace。SQLite/PG 的导出、导入 p95 比例分别为：Workspace Markdown 24.1%/13.2%、Workspace JSON 27.5%/14.4%、full Markdown 39.7%/11.8%、full JSON 28.6%/13.0%，全部低于 150% 门槛。 |
| 构建与 Docker 运行时 | `bun run build:web --force`、`bun run verify:rust`、macOS 原生 `cargo build --release --locked --manifest-path server/Cargo.toml`、Linux arm64 与 amd64 Docker release 均通过。arm64 运行时镜像在没有 PostgreSQL 容器的情况下启动，`/health` 返回 `{"status":"ok"}`；容器内数据目录为 `0700`，数据库及 WAL 为 `0600`。 |
| macOS 本机持久化 | 在隔离用户目录中实际执行 `install → update → smoke:rust → smoke:agent → stop → start → uninstall`，全程不启动 Docker。重启后原账号能登录、笔记数不变；卸载后 `blinkora.sqlite3` 保留，`integrity_check=ok`、`foreign_key_check` 为 0。发布产物位于用户目录；启动前清理二进制 provenance 并进行 ad-hoc 签名，静态页面可访问，服务不会因 `OS_REASON_CODESIGNING` 退出。 |

## 待验 / 阻断发布

- 已在真实 S3-compatible MinIO 服务验证附件链路；尚未使用第三方云厂商账户执行同一清单。
- 数据相关浏览器 smoke 尚未完成：本环境的浏览器运行时拒绝访问本机 `127.0.0.1`（`ERR_BLOCKED_BY_CLIENT`），需要可访问候选服务的桌面/移动端浏览器执行清单。
- 飞牛实际机器的 systemd 安装、更新、启动、停止和卸载尚未执行；已有单服务部署说明，但不能用 Linux Docker 构建结果代替飞牛实机验收。

在以上项目补齐并记录结果前，本次不能标记为“全部验收通过”。
