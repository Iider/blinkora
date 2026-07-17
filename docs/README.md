# Blinkora 文档

这里收录 Blinkora Rust 主栈的部署、产品行为、数据迁移、测试和运维文档。项目概览与快速开始见 [根 README](../README.zh-CN.md)。

## 项目入口

- [Docker 部署](../docker/README.md)：镜像构建、更新、数据目录、存储配置和烟测。
- [Rust 服务端](../server/README.md)：本地开发、构建、数据库初始化和服务端烟测。

## 部署与运维

- [Linux 无头单二进制部署](./LINUX_HEADLESS_DEPLOYMENT.md)：x86_64 Linux 服务器的 systemd、升级、回退与数据目录规范。
- [飞牛常驻部署](./FNAS_PERSISTENT_DEPLOYMENT.md)：飞牛服务器上的单 Rust 服务、SQLite 数据目录和物理备份。
- [macOS 本机持久化部署](./LOCAL_PERSISTENT_DEPLOYMENT.md)：通过 `launchd` 常驻运行，SQLite 与附件保存在本机数据目录。

## 产品行为与外部接入

- [笔记状态模型](./NOTE_STATE_LIFECYCLE.md)：闪念、笔记、待办的类型转换、归档、回收站、置顶、回顾、列表交互、卡背和引用展示规则。
- [Workspace Agent 接入](./WORKSPACE_AGENT_ACCESS.md)：工作区令牌、MCP、skill、操作日志增量查询的用法和安全边界。
- [Workspace 数据生命周期](./WORKSPACE_DATA_LIFECYCLE.md)：Workspace 删除清理、卡片跨工作区移动、S3 注意事项和残留检查。

## 构建、测试与验收

- [Bun 网络策略](./BUN_NETWORK_STRATEGY.md)：国内网络、镜像源和构建链路说明。
- [核心产品烟测清单](./SMOKE_TEST_CHECKLIST.md)：Rust 运行栈的手动烟测步骤与结果记录格式。
- [SQLite 收尾清单](./SQLITE_CLOSEOUT_CHECKLIST.md)：本地软件交付、生产迁移和后续完善的验收标准。

## 迁移与历史记录

- [旧安装迁移到 SQLite](./POSTGRES_TO_SQLITE_MIGRATION.md)：PostgreSQL 旧安装的迁移、验证、性能对比和回滚演练。
- [SQLite 替换验收记录](./SQLITE_MIGRATION_ACCEPTANCE.md)：PostgreSQL → SQLite 已执行的验收证据与历史待验项。
- [M2 生产切换运行手册（历史）](./M2_PRODUCTION_CUTOVER_RUNBOOK.md)：此前飞牛 PostgreSQL 迁移到 macOS 的预案，仅供追溯，不用于当前飞牛 SQLite 服务。
