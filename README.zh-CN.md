# Blinkora

Blinkora 是一个 Docker 部署的 Web-only 私人笔记和记忆底座，聚焦长期笔记、wiki 式记忆、标签、附件、引用、回顾、搜索/RAG、导出和私有批注。

Blinkora 由 Rust 后端直接托管浏览器应用。原生客户端、离线安装/运行时壳、公开分享、社交功能和对话式 AI 功能都不在当前产品范围内。

## 运行栈

| 模块 | 路径 | 角色 |
| --- | --- | --- |
| Web 前端 | `app/` | React/Vite 前端 |
| Rust 后端 | `server/` | 唯一维护的服务端 |
| 数据库结构 | `db/schema.sql` | 首版 PostgreSQL 建库脚本 |
| 共享代码 | `shared/` | 前端和 Rust API 兼容的共享类型/工具 |
| Docker 部署 | `docker/` | 默认部署入口 |

Rust 后端以单二进制承接 REST API、tRPC 兼容入口、文件接口、MCP SSE、健康检查、首启建表和 React/Vite 静态资源托管。

## Docker 部署

在开发机或 CI 生成 release 产物：

```bash
bun install
bun run build:rust-release
```

启动 Rust runtime：

```bash
cd docker
docker compose up -d
```

本机默认入口是 [http://localhost:6676](http://localhost:6676)。公网或正式部署时复制 `docker/.env.tmpl` 为 `docker/.env`，替换 `BLINKORA_SECRET`。

`bun run build:rust-release` 会同步生成 `docker/release/rust` 部署副本。部署服务器拿到 `docker/` 和其中的 `release/rust` 后，只需要 Docker。

## 开发命令

```bash
bun install
bun run dev:rust
bun run dev:frontend
bun run build:web --force
bun run build:rust-release
bun run verify:rust
```

前端开发服务默认使用 `http://localhost:5173`，并把 API 请求代理到 Rust 开发后端 `http://127.0.0.1:6677`。可通过 `BLINKORA_DEV_FRONTEND_PORT` 或 `BLINKORA_DEV_BACKEND_URL` 覆盖。

## 数据目录

- 应用数据：`docker/data/blinkora`
- Postgres 数据：`docker/data/postgres`
- 备份/导出目录：`docker/data/backup`

## 存储配置

默认使用本地文件系统，附件保存在 `docker/data/blinkora/files`。也可以在设置页切换到 S3 兼容对象存储，适用于阿里云 OSS、腾讯 COS 等兼容 S3 API 的服务。

S3 配置项是全局配置，只有超级管理员可以修改。需要填写端点、访问密钥 ID、访问密钥、桶和地区；自定义路径可选，例如 `blinkora/`。自定义路径为空时，文件直接写入桶根目录。

点击“保存并验证”后，Blinkora 会临时上传、读取并删除一个校验文件。验证通过才启用 S3；验证失败时实际存储保持本地，但 S3 表单会继续显示，方便直接修正配置。

任何 schema 或存储改动前，都要保持导出和备份路径可用。
