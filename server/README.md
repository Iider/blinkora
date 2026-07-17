# Blinkora Server

`server/` 是 Blinkora 唯一维护的服务端。Rust 二进制提供 REST API、tRPC 兼容入口、文件接口、MCP SSE、健康检查、SQLite 首次初始化和 React/Vite 静态资源。

## 本地开发

```bash
bun run dev:rust
```

默认监听 `http://127.0.0.1:6677`，SQLite 与附件写入 `.blinkora/dev`。可通过 `BIND_ADDR`、`DATA_DIR` 和 `PORT` 覆盖。前端资源与 schema 在 release 构建时内置到 Rust 二进制。

## Linux 发布物

```bash
bun run build:linux-headless
```

产物包括单独的 `blinkora-server-<version>-linux-x86_64`、可直接转交给用户或 Agent 的 `.tar.gz` 部署包，以及各自的 SHA-256 文件。分享包内置安装说明、校验清单和 systemd 安装器。目标服务器直接运行静态二进制，不需要 Bun、Node.js、Rust、SQLite CLI 或容器运行时。

本机缺少 Linux musl 交叉编译环境时，构建脚本会尝试 Docker builder；也可以显式设置 `BLINKORA_RUST_DOCKER_BUILD=1`。该 builder 只存在于构建机，定义在 `docker/rust-builder.Dockerfile`，不生成运行时镜像。

部署、升级与回退见 [Linux 无头单二进制部署](../docs/LINUX_HEADLESS_DEPLOYMENT.md)。

## macOS 本机部署

```bash
bun run deploy:local install
```

脚本构建本机二进制并安装 `launchd` 服务。细节见 [macOS 本机持久化部署](../docs/LOCAL_PERSISTENT_DEPLOYMENT.md)。

常用检查：

```bash
bun run deploy:local status
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6676/
```

## 数据库初始化

服务启动时检查 SQLite schema 版本和必需表。空数据目录执行二进制内置的 schema；未知非空库、损坏库或版本过新都会拒绝启动，不会静默创建新库。

## Smoke

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```

使用隔离验收实例、上方的 `BLINKORA_BASE_URL`/测试账号，以及完整 `BLINKORA_S3_SMOKE_*` 变量时，可执行 `BLINKORA_S3_SMOKE_ISOLATED=1 bun run smoke:s3`。该命令验证 S3 配置保存、上传、读取、移动、删除和本地存储回退；缺少变量会失败，且不应在生产实例运行。
