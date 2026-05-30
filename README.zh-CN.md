# Blinkora

Blinkora 是一个 Docker 部署的 Web-only 私人笔记和记忆底座。当前 fork 聚焦长期笔记、wiki 式记忆、标签、附件、引用、回顾、搜索/RAG、导出和私有批注。

桌面/移动客户端、Tauri、PWA 安装/离线、插件运行时、公开分享、社交功能和 AI chat 编排都不在当前范围内。外部 agent 应通过未来 memory/backend API 接入，而不是内置在 Blinkora 中。

## 后端状态

| 后端 | 路径 | 运行角色 | Docker 入口 | 本地地址 |
| --- | --- | --- | --- | --- |
| Rust | `server-rust/` | 主后端 | `docker/docker-compose.rust.yml` | `http://localhost:6676` |
| TS/Node | `server/` | 参考实现，保留到 Rust 不再需要对照为止 | `docker/docker-compose.yml` | 手动运行时为 `http://localhost:6678` |
| Go | 已归档 | 已从 active tree 移除 | `docker/backups/` local ignored archive | 无 |

Rust 后端以单二进制承接 REST API、tRPC 兼容入口、文件接口、MCP SSE、健康检查、SQL 迁移和 React/Vite 静态资源托管。TS/Node 后端只作为 Rust parity 对照保留。

## Rust Docker 部署

在开发机或 CI 生成 release 产物：

```bash
bun run build:rust-release
```

启动 Rust runtime 镜像：

```bash
NEXTAUTH_SECRET=请替换为安全随机字符串 docker compose -f docker/docker-compose.rust.yml build web
NEXTAUTH_SECRET=请替换为安全随机字符串 docker compose -f docker/docker-compose.rust.yml up -d
```

使用本地测试账号执行 Rust smoke：

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```

验证纯前端改动时，release 打包前使用 `bun run build:web --force`，避免 Turbo 恢复过期静态资源。当 `release/rust` 已生成后，部署服务器只需要 Docker。Rust runtime 镜像不包含 Node、Bun、npm、cargo、Go 或 Rust 编译器。

## TS/Node 参考栈

仅在需要和旧实现对照行为时运行 TS/Node 栈：

```bash
NEXTAUTH_SECRET=请替换为安全随机字符串 docker compose -f docker/docker-compose.yml build web
NEXTAUTH_SECRET=请替换为安全随机字符串 docker compose -f docker/docker-compose.yml up -d
```

TS/Node 参考栈映射到 `http://localhost:6678`，避免占用 Rust 主栈的 `6676`。

## 开发命令

```bash
bun install
bun run prisma:generate
bun run dev:rust
bun run dev:frontend
bun run build:web --force
bun run verify:rust
```

前端开发服务默认使用 `http://localhost:5173`，并把 API 请求代理到 Rust 开发后端 `http://127.0.0.1:6677`。可通过 `BLINKORA_DEV_FRONTEND_PORT` 或 `BLINKORA_DEV_BACKEND_URL` 覆盖。

## 数据和导出

- Rust 应用数据：`docker/data/blinkora-rust`
- Rust Postgres 数据：`docker/data/postgres-rust`
- Rust 备份/导出目录：`docker/data/backup-rust`
- Go 栈归档：本地备份放在 `docker/backups/`，不提交到 Git

任何 schema 或存储改动前，都要保持导出和备份路径可用。
