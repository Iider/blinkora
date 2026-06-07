# Blinkora Docker 部署目录

`docker/` 是默认部署入口。生成 release 后，用户进入这个目录执行 `docker compose up -d` 即可启动 Rust 主栈。

## 文件

| 路径 | 用途 |
| --- | --- |
| `compose.yml` | 默认 Rust 部署入口 |
| `dockerfile.rust` | Rust runtime 镜像，只复制预构建产物 |
| `dockerfile.rust.fullbuild` | Docker 内编译兜底，只用于构建机或排障 |
| `.env.tmpl` | 正式部署环境变量模板 |
| `release/rust/` | `bun run build:rust-release` 生成的部署产物 |
| `data/` | 宿主机持久化数据 |

## 部署

在项目根目录生成 release：

```bash
bun run build:rust-release
```

进入部署目录启动：

```bash
cd docker
docker compose up -d
docker compose ps
docker compose logs --tail=80 web
```

本机私用可以直接启动。公网或正式部署时先创建 `docker/.env`：

```bash
cp .env.tmpl .env
openssl rand -hex 32
```

把生成的随机值写入 `BLINKORA_SECRET`。

## 数据目录

| 路径 | 容器路径 | 用途 |
| --- | --- | --- |
| `data/blinkora` | `/app/.blinkora` | 附件、图片、临时上传和向量文件 |
| `data/backup` | `/app/backup` | 导出备份目录 |
| `data/postgres` | `/var/lib/postgresql/data` | PostgreSQL 数据目录 |

Postgres 官方镜像初始化数据库时要求数据目录为空；首次启动前不要在 `data/postgres` 放 `.gitkeep` 或其他占位文件。

## 存储

默认附件存储在 `data/blinkora/files`。切换到 S3 兼容对象存储后，上传文件写入设置页配置的桶和自定义路径；本地目录仍保留用于临时文件、导出和向量数据。

S3 配置在应用设置页维护，不写入 `docker/.env`。填写端点、访问密钥 ID、访问密钥、桶、地区后执行“保存并验证”。验证通过才启用 S3；验证失败时运行时继续使用本地存储，设置页保留 S3 表单以便继续修改。

## Smoke

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```

## 静态资源规则

Rust 后端托管前端时，Vditor / Lute 等动态资源由镜像内 `/app/public/vditor-assets/dist/js/*` 提供。缺失的 `.js`、`.css` 等带扩展名资源应返回 `404`，不能 fallback 到 `index.html`。
