# Blinkora

[English](README.md) | 简体中文

Blinkora 是一个原生单二进制优先、Web-only 的私人笔记和记忆底座，聚焦长期笔记、wiki 式知识、标签、附件、引用、每日回顾、操作日志、搜索、导出和私有批注。

一个 Rust 可执行文件同时提供浏览器应用、API、健康检查、SQLite 首次初始化和内置前端资源。SQLite 与附件保存在 `DATA_DIR`，升级不会替换配置或数据。Blinkora 不依赖容器运行时。

原生客户端、公开分享、社交功能、内置对话式 AI、RAG、embedding、向量检索和语义检索不在当前产品范围内。

## 运行栈

| 模块 | 路径 | 角色 |
| --- | --- | --- |
| Web 前端 | `app/` | 构建后内置到发布二进制的 React/Vite 前端 |
| Rust 后端 | `server/` | 唯一维护的服务运行时 |
| 数据库结构 | `db/schema.sqlite.sql` | 构建时内置的 SQLite schema |
| 共享代码 | `shared/` | 前端友好的共享类型和工具 |
| 发布模板 | `deploy/linux-package/` | Linux 分享包内的 Agent 指南、安装器和 systemd unit |
| 发布脚本 | `scripts/` | Linux 打包、macOS 服务安装、烟测和备份 |

## 发布范围

| 平台 | 交付方式 |
| --- | --- |
| x86_64 无头 Linux | 静态单二进制，当前主要发布目标 |
| macOS | 通过 `launchd` 安装原生 Rust 服务 |
| Windows 与 Linux arm64 | 暂未打包 |

## 运行 Linux 二进制

使用预先构建的 `blinkora-server-<version>-linux-x86_64` 发布文件。临时在本机运行不需要安装器：

```bash
chmod +x blinkora-server-<version>-linux-x86_64
mkdir -p data
NODE_ENV=production \
BLINKORA_SECRET="$(openssl rand -hex 32)" \
DATA_DIR="$PWD/data" \
./blinkora-server-<version>-linux-x86_64
```

访问 `http://127.0.0.1:6676`。需要常驻运行或开放网络访问时，使用 [Linux systemd 部署指南](docs/LINUX_HEADLESS_DEPLOYMENT.md)；它会把稳定密钥保存在二进制外，并说明升级、备份和回退。

维护者使用以下命令构建发布物：

```bash
bun install
bun run build:linux-headless
```

产物包括单独的二进制及 SHA-256 文件，以及可以直接分享的 `blinkora-<version>-linux-x86_64.tar.gz` 部署包。分享包内含 Agent 指南、安装脚本、systemd unit、版本元数据和逐文件校验清单；对方的 Agent 解压后应先阅读 `AGENTS.md`，再执行预检和安装。本机缺少 Linux musl 交叉编译环境时，可以在构建机上使用 Docker 兜底；目标服务器始终不需要 Docker。

## macOS

构建原生 Rust 服务并安装为 `launchd` 常驻任务：

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

前端默认运行在 `http://localhost:5173`，并把 API 请求代理到 `http://127.0.0.1:6677` 的 Rust 后端。开发数据默认写入 `.blinkora/dev`。可通过 `BLINKORA_DEV_FRONTEND_PORT` 和 `BLINKORA_DEV_BACKEND_URL` 覆盖访问地址。

常用检查：

```bash
bun run typecheck
bun run build:web --force
bun run verify:rust
```

服务端开发和数据库初始化细节见 [Rust 服务端](server/README.md)。

## 数据与存储

| 运行方式 | 持久化数据目录 |
| --- | --- |
| Linux 无头服务器 | 部署者指定的 `DATA_DIR` |
| macOS 本机服务 | `~/.blinkora/local/data` |
| 本地开发 | `.blinkora/dev` |

附件默认使用本地文件系统。超级管理员可以在上传、读取和删除校验成功后启用 S3 兼容存储。调整 schema、存储或部署方式前，应一起备份 SQLite、附件和导出文件。Workspace 删除与附件清理规则见 [Workspace 数据生命周期](docs/WORKSPACE_DATA_LIFECYCLE.md)。

## Workspace Agent 接入

设置 → 基本信息中创建的工作区令牌，只授权外部 Agent 通过 MCP 和白名单 API 访问一个 Workspace。它不是账号令牌，也不能访问其他 Workspace。数据库备份可能包含令牌材料，需要按敏感数据保护；不要把令牌写进源码、Skill、脚本、文档或 Git 历史。

令牌权限、MCP 配置、Skill 下载、操作日志和烟测方式见 [Workspace Agent 接入](docs/WORKSPACE_AGENT_ACCESS.md)。

## 文档

通过[文档索引](docs/README.md)查找部署手册、产品行为约定、迁移记录和测试清单。
