# 本机持久化部署

这个部署方式只用 Docker 跑 PostgreSQL，Blinkora Web/Rust 服务跑在 macOS 本机，由 `launchd` 常驻。

适合个人电脑长期使用：

- PostgreSQL 数据：`docker/data/postgres`
- Blinkora 附件和运行数据：`~/.blinkora/local/data`
- 本机服务配置：`~/.blinkora/local/blinkora.env`
- 本机服务日志：`~/.blinkora/local/logs`
- 访问地址：`http://localhost:6676`

## 前置条件

- Docker 或 OrbStack：只用于 PostgreSQL。
- Bun：构建前端资源。
- Rust toolchain：编译 macOS 本机 `blinkora-server`。

缺 Bun：

```bash
curl -fsSL https://bun.sh/install | bash
```

缺 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## 一键安装

```bash
bun run deploy:local install
```

脚本会做这些事：

- 启动 Docker PostgreSQL：`docker compose up -d db`
- 停掉旧的 `blinkora-web` 容器，释放 `6676` 端口
- 构建前端静态资源和 macOS 本机 Rust 二进制
- 生成 `~/.blinkora/local/blinkora.env`
- 安装并启动 `launchd` 服务：`com.blinkora.local`

## 日常命令

```bash
bun run deploy:local status
bun run deploy:local logs
bun run deploy:local restart
bun run deploy:local stop
bun run deploy:local start
bun run deploy:local update
```

只启动或停止 PostgreSQL：

```bash
bun run deploy:local db-up
bun run deploy:local db-stop
```

卸载本机服务但保留数据：

```bash
bun run deploy:local uninstall
```

## 安装后确认

安装完成后先看服务状态：

```bash
bun run deploy:local status
```

正常情况：

- `launchd` 里 `com.blinkora.local` 是 `running`。
- Docker 里 `blinkora-db` 是 `healthy`。
- 不需要 `blinkora-web` 容器。

再确认端口：

```bash
lsof -nP -iTCP:6676 -sTCP:LISTEN
curl -I http://127.0.0.1:6676/
```

`curl` 返回 `200 OK`，或浏览器能打开 `http://localhost:6676`，就说明服务可用。

## 配置

默认配置写在 `~/.blinkora/local/blinkora.env`：

```env
NODE_ENV=production
PORT=6676
DATABASE_URL=postgresql://postgres:mysecretpassword@127.0.0.1:55433/postgres
PUBLIC_PATH=<repo>/release/local/public
DATA_DIR=~/.blinkora/local/data
SCHEMA_PATH=<repo>/release/local/db/schema.sql
BLINKORA_SECRET=<自动生成>
RUST_LOG=info
```

`BLINKORA_SECRET` 首次安装自动生成。不要提交到仓库，也不要复制到文档里。

## Docker 和本机服务的边界

本机持久化部署只保留 `blinkora-db` 容器。`blinkora-web` 容器不需要运行。

如果之前跑过完整 Docker 部署，安装脚本会执行：

```bash
cd docker
docker compose stop web
```

数据库容器继续运行，数据仍在 `docker/data/postgres`。

## 访问不到时先看这里

先跑：

```bash
bun run deploy:local status
```

按下面顺序排：

| 现象 | 优先检查 | 处理 |
| --- | --- | --- |
| 页面打不开 | `launchd` 是否 running，`lsof` 是否监听 `6676` | `bun run deploy:local restart` |
| 数据库连不上 | `blinkora-db` 是否 healthy | `bun run deploy:local db-up` |
| 端口被占用 | 是否还有旧 `blinkora-web` 或其他服务占着 `6676` | `cd docker && docker compose stop web`，再 `bun run deploy:local restart` |
| 日志里有 `getcwd: Operation not permitted` | launchd 工作目录是否还是项目目录 | 更新脚本后重新 `bun run deploy:local start`，当前脚本已把工作目录放到 `~/.blinkora/local` |
| `bun` 或 `cargo` 找不到 | Homebrew、Bun、Rust 是否已安装 | 安装后重新打开终端；脚本已自动加入 `/opt/homebrew/bin`、`~/.bun/bin`、`~/.cargo/bin` |
| Codex 内部 `curl` 失败，但浏览器能打开 | Codex 沙盒可能拦了本地网络 | 以浏览器或普通终端结果为准 |

看最近日志：

```bash
tail -n 80 ~/.blinkora/local/logs/blinkora.out.log
tail -n 80 ~/.blinkora/local/logs/blinkora.err.log
```

只想回到完整 Docker 部署时，先停本机服务：

```bash
bun run deploy:local stop
cd docker
docker compose up -d --build
```
