# Blinkora

[English](README.md) | 简体中文

Blinkora 是一个 Docker-first、Web-only 的私人笔记和记忆底座，聚焦长期笔记、wiki 式知识、标签、附件、引用、每日回顾、操作日志、搜索、导出和私有批注。

Rust 后端通过单个二进制提供浏览器应用、API、健康检查、SQLite 首次初始化和内置前端资源。SQLite 与附件统一保存在 `DATA_DIR`。原生客户端、公开分享、社交功能，以及内置的对话式 AI、RAG、embedding、向量或语义检索运行时不在当前产品范围内。

## 运行栈

| 模块 | 路径 | 角色 |
| --- | --- | --- |
| Web 前端 | `app/` | React/Vite 前端 |
| Rust 后端 | `server/` | 唯一维护的服务端 |
| 数据库结构 | `db/schema.sqlite.sql` | 构建时内置的 SQLite schema |
| 共享代码 | `shared/` | 前端友好的共享类型和工具 |
| Docker 部署 | `docker/` | 默认单容器部署入口 |

## 环境要求

- Bun 1.2.8 或更高版本
- Node.js 20 或更高版本，用于验收和烟测脚本
- Docker 与 Compose，用于 Docker 部署和 Docker 兜底的 Linux 构建
- Rust toolchain，用于服务端本机开发和 macOS 本机部署

## 快速开始

### Docker

Docker 是默认部署方式：

```bash
bun install
bun run build:rust-release
cd docker
docker compose up -d
```

访问 [http://localhost:6676](http://localhost:6676)。正式环境密钥、重新构建、存储目录和烟测说明见 [Docker 部署](docker/README.md)。

### Linux 无头服务器

构建内置前端与 SQLite schema 的 x86_64 Linux 静态二进制：

```bash
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:linux-headless
```

目标服务器不需要 Docker、Bun、Node.js、Rust、SQLite CLI、GUI 或 FUSE。使用 systemd 或其他进程守护程序运行，配置与数据保存在二进制外。安装、升级和回退见 [Linux 无头单二进制部署](docs/LINUX_HEADLESS_DEPLOYMENT.md)。

### macOS

不使用 Docker，将 Rust 服务安装为 `launchd` 常驻任务：

```bash
bun run deploy:local install
```

日常检查使用 `bun run deploy:local status` 和 `bun run deploy:local logs`。前置条件、更新、备份与恢复见 [macOS 本机持久化部署](docs/LOCAL_PERSISTENT_DEPLOYMENT.md)。

## 本地开发

```bash
bun install
bun run dev:rust
bun run dev:frontend
```

前端默认运行在 `http://localhost:5173`，并把 API 请求代理到 `http://127.0.0.1:6677` 的 Rust 后端。可通过 `BLINKORA_DEV_FRONTEND_PORT` 和 `BLINKORA_DEV_BACKEND_URL` 覆盖。

常用检查：

```bash
bun run typecheck
bun run build:web --force
bun run verify:rust
```

服务端开发和数据库初始化细节见 [Rust 服务端](server/README.md)。

## 数据与存储

| 部署方式 | 持久化数据目录 |
| --- | --- |
| Docker | `docker/data/blinkora` |
| macOS 本机服务 | `~/.blinkora/local/data` |
| Linux 无头服务器 | 部署者指定的 `DATA_DIR` |

附件默认使用本地文件系统。超级管理员可以在设置页启用 S3 兼容存储，系统只有在上传、读取和删除校验都成功后才会切换。调整 schema、存储或部署方式前，应一起备份 SQLite、附件和导出文件。Workspace 删除与附件清理规则见 [Workspace 数据生命周期](docs/WORKSPACE_DATA_LIFECYCLE.md)。

## Workspace Agent 接入

设置 → 基本信息中创建的工作区令牌，只授权外部 Agent 通过 MCP 和白名单 API 访问一个 Workspace。它不是账号令牌，也不能访问其他 Workspace。数据库备份可能包含令牌材料，需要按敏感数据保护；不要把令牌写进源码、skill、脚本、文档或 Git 历史。

令牌权限、MCP 配置、skill 下载、操作日志和烟测方式见 [Workspace Agent 接入](docs/WORKSPACE_AGENT_ACCESS.md)。

## 文档

通过[文档索引](docs/README.md)查找部署手册、产品行为约定、迁移记录和测试清单。
