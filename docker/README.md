# Blinkora Docker 部署目录

这个目录集中管理 Blinkora 的 Docker 部署配置，以及容器需要持久化到宿主机的数据目录。

## 当前 Docker 入口

| Compose 文件 | 后端 | 容器 | 用途 |
| --- | --- | --- | --- |
| `docker-compose.rust.yml` | Rust / `server-rust` | `blinkora-rust-web`、`blinkora-rust-db` | 主运行栈，后端托管前端 `dist`，runtime 为单 Rust 二进制 |
| `docker-compose.yml` | TS/Node / `server` | `blinkora-web`、`blinkora-db` | 参考栈，仅用于和 Rust 行为对照 |

Go 栈已经从 active tree 移除。归档包保存在 `docker/backups/blinkora-go-stack-archive-2026-05-29.zip`，包含 `server-go/`、Go Dockerfile/compose、Go release 产物和相关迁移记录。

## Rust 主部署模型

推荐把部署链路拆成两段：

| 阶段 | 运行位置 | 需要的工具 | 产物 |
| --- | --- | --- | --- |
| Release 构建 | 开发机或 CI | Bun、Rust 工具链或 Docker builder | `release/rust/*` |
| Docker 部署 | 服务器 | Docker | `blinkora-rust-web:latest` 运行镜像 |

服务器侧不需要安装 Node、Bun、npm、Go 编译器、cargo 或 Rust 编译器；`docker/dockerfile.rust` 只复制 `release/rust` 目录中的 Linux 二进制、静态资源和 SQL migrations。前端或 Rust 后端代码变化后，必须先重新生成 `release/rust`，再构建镜像。

Rust 后端启动时会自动执行镜像内 `/app/prisma/migrations` 下的 SQL 迁移，空库不需要手工执行 Prisma CLI 或逐个导入 `migration.sql`。

## 目录结构

| 路径 | 容器路径 | 用途 |
| --- | --- | --- |
| `data/blinkora-rust` | `/app/.blinkora` | Rust 主栈本地文件、附件、图片、临时上传和向量文件 |
| `data/backup-rust` | `/app/backup` | Rust 主栈导出备份目录 |
| `data/postgres-rust` | `/var/lib/postgresql/data` | Rust 主栈 PostgreSQL 数据目录 |
| `data/minio-rust` | `/data` | Rust S3 smoke profile 的 MinIO 数据目录 |
| `data/blinkora` | `/app/.blinkora` | TS/Node 参考栈本地文件数据 |
| `data/backup` | `/app/backup` | TS/Node 参考栈备份目录 |
| `data/postgres` | `/var/lib/postgresql/data` | TS/Node 参考栈 PostgreSQL 数据目录 |

Postgres 官方镜像初始化数据库时要求数据目录为空；首次启动前不要在对应 `data/postgres*` 目录放 `.gitkeep` 或其他占位文件。

## Rust 常用命令

需要从项目根目录执行：

```bash
bun run build:rust-release
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml build web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml up -d
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml ps
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml logs --tail=80 web
```

Rust 主栈地址：

```text
http://localhost:6676
```

Rust smoke（需要显式提供测试账号，不在脚本中保留默认密码）：

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```

需要从零验证 Rust 后端镜像时：

```bash
bun run build:rust-release
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml down --rmi all --remove-orphans
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml build --no-cache web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml up -d
BLINKORA_BASE_URL=http://127.0.0.1:6676 BLINKORA_SMOKE_USER=<test-user> BLINKORA_SMOKE_PASSWORD=<test-password> bun run smoke:rust
```

## Rust S3 / OSS 兼容 smoke

启用 MinIO profile：

```bash
bun run build:rust-release
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml --profile s3-smoke build web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml --profile s3-smoke up -d
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
BLINKORA_S3_SMOKE_ENDPOINT=http://minio:9000 \
BLINKORA_S3_SMOKE_BUCKET=blinkora-rust-smoke \
BLINKORA_S3_SMOKE_ACCESS_KEY=blinkora \
BLINKORA_S3_SMOKE_SECRET_KEY=blinkora-rust-s3-secret \
BLINKORA_S3_SMOKE_REGION=us-east-1 \
bun run smoke:rust
```

MinIO profile 会额外启动 `blinkora-rust-minio` 和一次性 `blinkora-rust-minio-init`，用于创建 smoke bucket；默认 Rust 部署不启动 MinIO。

## 本地开发入口

```bash
bun run dev:frontend
bun run dev:rust
```

`bun run dev:rust` 默认监听 `http://127.0.0.1:6677`，连接 `localhost:55433` 上的 Rust Docker PostgreSQL，并使用 `dist/public` 作为静态资源目录。`bun run dev:frontend` 默认监听 `http://localhost:5173`，并把 `/api`、`/trpc`、`/sse`、`/messages` 和 `/vditor-assets` 代理到 Rust 开发后端。TS/Node 本地后端只作为参考栈，使用 `bun run dev:backend`。

## TS/Node 参考栈

TS/Node 参考栈仅用于行为对照，不作为默认部署入口。它映射到 `http://localhost:6678`，避免占用 Rust 主栈的 `6676`。

```bash
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.yml config
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.yml build web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.yml up -d
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.yml ps
```

## Rust fullbuild 兜底

如果确实需要在 Docker 内完成 Rust 编译，可临时指定兜底 Dockerfile：

```bash
docker build -f docker/dockerfile.rust.fullbuild -t blinkora-rust-web:latest .
```

这条路径会访问 Rust crate 下载链路，只用于排障或构建机，不作为服务器默认部署方式。

## 静态资源规则

Rust 后端托管前端时，Vditor / Lute 等动态资源必须由镜像内 `/app/public/vditor-assets/dist/js/*` 提供。缺失的 `.js`、`.css` 等带扩展名资源应返回 `404`，不能 fallback 到 `index.html`。

不要把 `docker cp` 作为最终修复方式。源码、Dockerfile 或静态托管逻辑改完后，必须重新 build 镜像并重建容器。
