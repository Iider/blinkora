# Blinkora

Blinkora is a Docker-first Web-only private note and memory base for long-term notes, wiki-style memory, tags, attachments, references, review, search, export, and private annotations.

Blinkora is served as a browser app by the Rust backend. Default deployment uses Docker; personal macOS machines can also run the Rust service locally with Docker only keeping PostgreSQL. Native clients, public sharing, social features, and conversational AI features are outside the product scope.

## Runtime

| Module | Path | Role |
| --- | --- | --- |
| Web frontend | `app/` | React/Vite frontend |
| Rust backend | `server/` | Only maintained server runtime |
| Database schema | `db/schema.sql` | First-release PostgreSQL schema |
| Shared code | `shared/` | Frontend-friendly shared types and utilities |
| Docker deployment | `docker/` | Default full Docker entry and PostgreSQL compose entry |

The Rust backend serves REST APIs, tRPC-compatible endpoints, file APIs, MCP SSE, health checks, first-run database initialization, and React/Vite static assets from one binary.

Blinkora currently provides ordinary keyword, metadata, type, tag, attachment, link, TODO, and date filtering. It does not include built-in RAG, embedding, vector search, or semantic search. Workspace Agent/MCP tokens are an external agent access path, not a RAG index.

## Docker Deployment

Build release artifacts on a development machine or CI runner:

```bash
bun install
bun run build:rust-release
```

Start the Rust runtime:

```bash
cd docker
docker compose up -d
```

代码改完后，正在跑的 Docker 不会自动吃到新代码。按下面重建 release 和镜像：

```bash
bun run build:rust-release
cd docker
docker compose up -d --build
```

如果本机缺 Linux Rust 交叉编译器，release 步骤直接用 Docker builder：

```bash
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:rust-release
```

The local URL is [http://localhost:6676](http://localhost:6676). For public or production deployments, copy `docker/.env.tmpl` to `docker/.env` and replace `BLINKORA_SECRET`.

`bun run build:rust-release` syncs a deployment copy to `docker/release/rust`. A deployment server with `docker/` and its generated `release/rust` contents only needs Docker.

## Local Persistent Deployment

如果只想用 Docker 跑 PostgreSQL，而 Blinkora Web/Rust 服务跑在 macOS 本机：

```bash
bun run deploy:local install
```

脚本会启动 Docker `db` 服务，停掉旧的 `web` 容器，构建 macOS 本机 Rust 服务，并安装 `launchd` 常驻服务。完整说明见 [docs/LOCAL_PERSISTENT_DEPLOYMENT.md](docs/LOCAL_PERSISTENT_DEPLOYMENT.md)。

常用检查：

```bash
bun run deploy:local status
bun run deploy:local logs
```

访问地址仍是 [http://localhost:6676](http://localhost:6676)。这种模式下只需要 `blinkora-db` 容器，不需要 `blinkora-web` 容器。

## Development Commands

```bash
bun install
bun run dev:rust
bun run dev:frontend
bun run build:web --force
bun run build:rust-release
bun run verify:rust
```

Frontend dev uses `http://localhost:5173` and proxies API requests to the Rust dev backend at `http://127.0.0.1:6677` by default. Override with `BLINKORA_DEV_FRONTEND_PORT` or `BLINKORA_DEV_BACKEND_URL`.

## Workspace Agent Tokens

设置页“基本信息”里的“工作区令牌”用于给 Codex、OpenClaw、Pi Agent、Hermes 这类外部 Agent 发放单 Workspace 授权。它不是账号访问令牌，不能跨 Workspace 使用。

- token 格式为 `bkws_...`。数据库保留 SHA-256 hash 用于认证，也保存明文用于设置页回显；请按敏感数据保护数据库备份。
- 页面下拉框选择要授权的 Workspace，刷新按钮只更新这个下拉框选中的 Workspace token，不受页面顶栏当前 Workspace 影响。
- 刷新会撤销该 Workspace 旧的可用 Agent token，并生成新的可回显 token；页面底部会给出一段可直接复制给 AI 的调用指南。
- 任意有效工作区令牌都能读取只读安装资源：`${BLINKORA_BASE_URL}/api/agent/mcp-guide.md`、`${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md`、`${BLINKORA_BASE_URL}/api/agent/blinkora-workspace.zip`。
- 默认权限：闪念、笔记、待办读写；评论读写；标签树只读。
- scoped token 只能访问 MCP 和 notes/comments/tags 白名单 tRPC，不能访问 workspaces、config、backup、files、admin 类接口。
- 使用环境变量传给 Agent：`BLINKORA_BASE_URL=http://localhost:6676`、`BLINKORA_AGENT_TOKEN=<bkws_token>`。
- MCP 入口优先用 `${BLINKORA_BASE_URL}/sse`，后续消息地址由 SSE 的 `endpoint` 事件返回。
- 不要把 token 写进 skill、脚本、README、提交记录或仓库里的任何文件。

完整使用方式、下载命令和烟测重点见 `docs/WORKSPACE_AGENT_ACCESS.md`。

## Data

- App data: `docker/data/blinkora`
- Postgres data: `docker/data/postgres`
- Backup/export directory: `docker/data/backup`

本机持久化部署时，附件和运行数据改放在 `~/.blinkora/local/data`，PostgreSQL 仍使用 `docker/data/postgres`。

## Storage Configuration

Blinkora uses the local file system by default and stores attachments under `docker/data/blinkora/files`. S3-compatible object storage can be enabled from the settings page for providers such as Aliyun OSS, Tencent COS, and other S3-compatible services.

S3 settings are global configuration and require a superadmin account. Endpoint, Access Key ID, Secret Key, Bucket, and Region ID are required. Custom Path is optional; for example, `blinkora/`. When Custom Path is empty, files are stored in the bucket root.

The “Save and validate” action uploads, reads, and deletes a temporary validation object. S3 is enabled only after validation succeeds. If validation fails, active storage stays local while the S3 form remains open for correction.

Deleting a non-default Workspace also deletes its note data, resource records, linked local/S3 attachment files, configuration, and workspace tokens. See `docs/WORKSPACE_DATA_LIFECYCLE.md` for the cleanup contract and residual checks.

Keep export and backup paths working before schema or storage changes.
