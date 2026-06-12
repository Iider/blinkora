# Blinkora 文档

这里放 Blinkora 1.0 Rust 主栈的公开项目文档。临时日志、审计记录和会话记录不放进这里。

## 文档

- [Smoke test checklist](./SMOKE_TEST_CHECKLIST.md)：Rust 运行栈手动烟测清单。
- [Local persistent deployment](./LOCAL_PERSISTENT_DEPLOYMENT.md)：PostgreSQL 用 Docker，Rust Web 服务用 macOS `launchd` 常驻。
- [Workspace agent access](./WORKSPACE_AGENT_ACCESS.md)：工作区令牌、MCP、Skill 的使用和安全边界。
- [Workspace data lifecycle](./WORKSPACE_DATA_LIFECYCLE.md)：Workspace 删除清理范围、S3 注意事项和残留检查命令。
- [Bun network strategy](./BUN_NETWORK_STRATEGY.md)：国内网络、镜像源和构建链路说明。

## 运行方式

- Rust 后端：`server/`，默认访问地址 `http://localhost:6676`。
- 完整 Docker：`docker/compose.yml` 启动 `blinkora-web` 和 `blinkora-db`。
- 本机持久化：`bun run deploy:local install` 只启动 Docker `blinkora-db`，Rust 服务由 `launchd` 运行。
- Web 前端：`app/`，构建后进入 Rust release artifact。
