# Blinkora 文档

这里放 Blinkora 1.0 Rust 主栈的公开项目文档。临时日志、审计记录和会话记录不放进这里。

## 文档

- [Smoke test checklist](./SMOKE_TEST_CHECKLIST.md)：Rust 运行栈手动烟测清单。
- [SQLite 快速收尾清单](./SQLITE_CLOSEOUT_CHECKLIST.md)：区分本地软件交付、生产迁移和延期完善，并给出逐项验收标准。
- [SQLite 替换验收记录](./SQLITE_MIGRATION_ACCEPTANCE.md)：记录 PostgreSQL → SQLite 已实际执行的验收证据和待验项。
- [M2 生产切换运行手册（历史）](./M2_PRODUCTION_CUTOVER_RUNBOOK.md)：此前飞牛 PostgreSQL 迁移到 macOS 的预案，仅供追溯，不用于当前飞牛 SQLite 服务。
- [笔记状态模型](./NOTE_STATE_LIFECYCLE.md)：闪念、笔记、待办的类型转换、归档、回收站、置顶、回顾、列表交互、卡背和引用展示规则。
- [Local persistent deployment](./LOCAL_PERSISTENT_DEPLOYMENT.md)：macOS `launchd` 常驻，SQLite 与附件保存在本机数据目录。
- [Linux 便携版（AppImage）](./LINUX_PORTABLE_DEPLOYMENT.md)：x86_64 Linux 单文件双击运行，用户数据与应用升级隔离。
- [飞牛常驻部署](./FNAS_PERSISTENT_DEPLOYMENT.md)：单 Rust 服务加本地 SQLite 的 systemd 部署。
- [Workspace agent access](./WORKSPACE_AGENT_ACCESS.md)：工作区令牌、MCP、Skill、操作日志增量查询的使用和安全边界。
- [Workspace data lifecycle](./WORKSPACE_DATA_LIFECYCLE.md)：Workspace 删除清理、卡片跨工作区移动、S3 注意事项和残留检查命令。
- [Bun network strategy](./BUN_NETWORK_STRATEGY.md)：国内网络、镜像源和构建链路说明。

## 运行方式

- Rust 后端：`server/`，默认访问地址 `http://localhost:6676`。
- 完整 Docker：`docker/compose.yml` 只启动 `blinkora-web`，SQLite 与附件使用 `docker/data/blinkora`。
- 本机持久化：`bun run deploy:local install` 直接安装 `launchd` 服务；代码或前端构建变更后用 `bun run deploy:local update` 让 `localhost:6676` 生效。
- 飞牛常驻部署：新 SQLite 服务与旧 PostgreSQL 服务使用不同目录和 unit；切换时保留旧目录与数据作为回退副本，具体路径见 [飞牛常驻部署](./FNAS_PERSISTENT_DEPLOYMENT.md)。
- Web 前端：`app/`，构建后进入 Rust release artifact。
