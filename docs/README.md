# Blinkora 文档

这里放 Blinkora 1.0 Rust 主栈的公开项目文档。临时日志、审计记录和会话记录不放进这里。

## 文档

- [Smoke test checklist](./SMOKE_TEST_CHECKLIST.md)：Rust 运行栈手动烟测清单。
- [SQLite 快速收尾清单](./SQLITE_CLOSEOUT_CHECKLIST.md)：区分本地软件交付、生产迁移和延期完善，并给出逐项验收标准。
- [SQLite 替换验收记录](./SQLITE_MIGRATION_ACCEPTANCE.md)：记录 PostgreSQL → SQLite 已实际执行的验收证据和待验项。
- [M2 生产切换运行手册](./M2_PRODUCTION_CUTOVER_RUNBOOK.md)：飞牛 PostgreSQL 停写、最终快照、本机激活和回滚步骤。
- [笔记状态模型](./NOTE_STATE_LIFECYCLE.md)：闪念、笔记、待办的类型转换、归档、回收站、置顶、回顾、列表交互、卡背和引用展示规则。
- [Local persistent deployment](./LOCAL_PERSISTENT_DEPLOYMENT.md)：macOS `launchd` 常驻，SQLite 与附件保存在本机数据目录。
- [飞牛常驻部署](./FNAS_PERSISTENT_DEPLOYMENT.md)：单 Rust 服务加本地 SQLite 的 systemd 部署。
- [Workspace agent access](./WORKSPACE_AGENT_ACCESS.md)：工作区令牌、MCP、Skill、操作日志增量查询的使用和安全边界。
- [Workspace data lifecycle](./WORKSPACE_DATA_LIFECYCLE.md)：Workspace 删除清理、卡片跨工作区移动、S3 注意事项和残留检查命令。
- [Bun network strategy](./BUN_NETWORK_STRATEGY.md)：国内网络、镜像源和构建链路说明。

## 运行方式

- Rust 后端：`server/`，默认访问地址 `http://localhost:6676`。
- 完整 Docker：`docker/compose.yml` 只启动 `blinkora-web`，SQLite 与附件使用 `docker/data/blinkora`。
- 本机持久化：`bun run deploy:local install` 直接安装 `launchd` 服务；代码或前端构建变更后用 `bun run deploy:local update` 让 `localhost:6676` 生效。
- 当前 `local` 分支：macOS 本机常驻部署；飞牛继续保留 PostgreSQL 主服务，最终切换按 [M2 生产切换运行手册](./M2_PRODUCTION_CUTOVER_RUNBOOK.md) 执行。
- Web 前端：`app/`，构建后进入 Rust release artifact。
