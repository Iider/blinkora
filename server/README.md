# Blinkora Server

`server/` 是 Blinkora 唯一维护的服务端，当前实现为 Rust。它负责 REST API、tRPC 兼容入口、文件接口、MCP SSE、健康检查、首启建表和 React/Vite 静态资源托管。

## 本地开发

```bash
bun run dev:rust
```

默认监听 `http://127.0.0.1:6677`，连接 `localhost:55433` 上的 Rust Docker PostgreSQL，使用 `dist/public` 作为静态资源目录。可覆盖 `DATABASE_URL`、`PUBLIC_PATH`、`DATA_DIR`、`PORT`。

## 构建和部署

```bash
bun run build:rust-release
cd docker
docker compose up -d
```

`docker/dockerfile.rust` 只复制 `docker/release/rust` 中的 Linux 二进制、前端静态资源和 `db/schema.sql`。runtime 镜像不包含 Node、Bun、npm、cargo、Go 或 Rust 编译器。

如果本机无法交叉编译 Linux Rust 二进制，`bun run build:rust-release` 会回退到 Docker binary builder。`docker/dockerfile.rust.fullbuild` 仅用于排障或构建机。

## 数据库初始化

Rust 后端启动时会检查 `accounts` 表是否存在。空库会执行 `SCHEMA_PATH` 指向的 `db/schema.sql`；已有库会跳过初始化。当前只维护单份首版 schema。

## Smoke

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```

设置 `BLINKORA_S3_SMOKE_*` 环境变量后，smoke 会验证 S3 配置保存、上传、读取、移动、删除和本地存储回退。S3 依赖请自行使用真实服务或外部 S3 兼容服务，默认 Docker 部署不内置 S3 服务。
