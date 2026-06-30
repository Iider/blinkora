# 远端笔记本部署

当前个人常驻部署目标是一台 Ubuntu 笔记本。以后日常部署优先更新这台机器，不再把当前 Mac 作为常驻 Blinkora 服务。

## 当前入口

- Wi-Fi 地址：`http://192.168.2.25:6676`
- 有线地址：`http://192.168.2.34:6676`，仅网线接入且地址未变化时可用。
- 健康检查：`curl -fsS http://192.168.2.25:6676/health`

## 运行方式

远端采用“数据库 Docker，本体本地二进制”的方式：

- PostgreSQL：Docker 容器 `blinkora-db`
- Blinkora Web/Rust 服务：systemd 服务 `blinkora.service`
- Docker 镜像代理：`/etc/docker/daemon.json`
- Rust 二进制：`/home/ubuntu/blinkora/local/bin/blinkora-server`
- 静态资源：`/home/ubuntu/blinkora/local/public`
- schema：`/home/ubuntu/blinkora/local/db/schema.sql`
- 附件和运行数据：`/home/ubuntu/blinkora/local/data`
- 环境文件：`/home/ubuntu/blinkora/local/blinkora.env`
- 数据库 compose 目录：`/home/ubuntu/blinkora/docker`
- PostgreSQL 数据：`/home/ubuntu/blinkora/docker/data/postgres`

`blinkora.env` 里包含生产密钥，不要复制到文档或提交到仓库。

## 常用命令

在远端查看服务：

```bash
systemctl status blinkora.service
cd /home/ubuntu/blinkora/docker
docker compose ps
```

重启 Web 服务：

```bash
sudo systemctl restart blinkora.service
curl -fsS http://127.0.0.1:6676/health
```

查看数据库数量示例：

```bash
docker exec blinkora-db psql -U postgres -d postgres -tAc 'select count(*) from notes;'
```

## 更新流程

在开发机生成 Linux x86_64 release 产物：

```bash
TARGETARCH=amd64 DOCKER_DEFAULT_PLATFORM=linux/amd64 BLINKORA_RUST_DOCKER_BUILD=1 bun run build:rust-release
```

把 `docker/release/rust` 里的新二进制、`public` 和 `db` 同步到远端的 `/home/ubuntu/blinkora/local` 后，重启：

```bash
sudo systemctl restart blinkora.service
curl -fsS http://127.0.0.1:6676/health
```

## 迁移记录

2026-06-30 已把当前 Mac 上的 Blinkora 数据复制到远端：

- 数据库已恢复到远端 `blinkora-db`。
- 附件和运行数据已复制到 `/home/ubuntu/blinkora/local/data`。
- 首次迁移校验时 `notes` 数量为 `160`。这个数字只作为迁移记录，不作为后续当前数据量判断。

当前 Mac 的本机常驻服务已停止并禁用：

- `com.blinkora.local` 已从 launchd 卸载并禁用。
- 本机 Docker 容器 `blinkora-db` 已停止但未删除，数据仍保留。
