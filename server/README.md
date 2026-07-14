# Blinkora Server

`server/` 是 Blinkora 唯一维护的服务端，当前实现为 Rust。它负责 REST API、tRPC 兼容入口、文件接口、MCP SSE、健康检查、首启建表和 React/Vite 静态资源托管。

## 本地开发

```bash
bun run dev:rust
```

默认监听 `http://127.0.0.1:6677`，使用 `dist/public` 作为静态资源目录，并将 SQLite 文件与附件写入 `DATA_DIR`。可覆盖 `PUBLIC_PATH`、`DATA_DIR`、`PORT`。

## 构建和部署

```bash
bun run build:rust-release
cd docker
docker compose up -d
```

`docker/dockerfile.rust` 只复制 `docker/release/rust` 中的 Linux 二进制、前端静态资源和 `db/schema.sqlite.sql`。runtime 镜像不包含 Node、Bun、npm、cargo、Go 或 Rust 编译器。

如果本机无法交叉编译 Linux Rust 二进制，`bun run build:rust-release` 会回退到 Docker binary builder。`docker/dockerfile.rust.fullbuild` 仅用于排障或构建机。

## 本机持久化部署

macOS 可直接运行 Rust 服务：

```bash
bun run deploy:local install
```

脚本会构建本机二进制，并安装 `launchd` 服务。细节见 `docs/LOCAL_PERSISTENT_DEPLOYMENT.md`。

常用检查：

```bash
bun run deploy:local status
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6676/
```

本机持久化部署不需要 Docker。

## 数据库初始化

Rust 后端启动时会检查 SQLite 的 schema 版本和必需表。空数据目录会执行 `SCHEMA_PATH` 指向的 `db/schema.sqlite.sql`；未知非空库、损坏库或版本过新都会拒绝启动，不会静默创建新库。

## Smoke

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```

使用隔离验收实例、上方的 `BLINKORA_BASE_URL`/测试账号，以及完整 `BLINKORA_S3_SMOKE_*` 变量时，执行 `BLINKORA_S3_SMOKE_ISOLATED=1 bun run smoke:s3`。该命令会验证 S3 配置保存、上传、读取、移动、删除和本地存储回退；缺少变量会失败，且不应在生产实例运行。默认 Docker 部署不内置 S3 服务。
