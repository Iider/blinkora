# 飞牛常驻部署

Blinkora 当前的常驻服务运行在飞牛服务器；当前 Mac 只用于开发、构建和验证，不作为正式服务。

## 当前入口

- Web：`http://192.168.2.25:6676`
- 健康检查：`curl -fsS http://192.168.2.25:6676/health`

## 运行结构

部署根目录：`/vol1/1000/docker/blinkora`。

- Blinkora Web/Rust：systemd `blinkora.service`
- PostgreSQL：Docker Compose 的 `db` 服务，由 `blinkora-db.service` 拉起
- Rust 二进制：`/vol1/1000/docker/blinkora/local/bin/blinkora-server`
- 前端静态资源：`/vol1/1000/docker/blinkora/local/public`
- schema：`/vol1/1000/docker/blinkora/local/db/schema.sql`
- 运行配置：`/vol1/1000/docker/blinkora/local/blinkora.env`
- 附件和应用运行数据：`/vol1/1000/docker/blinkora/data/app`
- PostgreSQL 数据：`/vol1/1000/docker/blinkora/data/postgres`
- Compose 目录：`/vol1/1000/docker/blinkora/compose`
- 发布备份：`/vol1/1000/docker/blinkora/backups`

`blinkora.env` 含生产密钥，不要复制到文档、提交或命令历史。

## 日常检查

```bash
systemctl status blinkora.service
systemctl status blinkora-db.service
curl -fsS http://127.0.0.1:6676/health
```

重启 Web 服务：

```bash
sudo systemctl restart blinkora.service
systemctl is-active blinkora.service
```

查看数据库容器：

```bash
cd /vol1/1000/docker/blinkora/compose
docker compose ps
```

## 发布更新

开发机先构建 Linux x86_64 release：

```bash
TARGETARCH=amd64 DOCKER_DEFAULT_PLATFORM=linux/amd64 \
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:rust-release
```

发布只替换这三类产物：

- `release/rust/blinkora-server`
- `release/rust/public/`
- `release/rust/db/schema.sql`

远端操作应先把当前二进制、`public/` 和 schema 复制到
`/vol1/1000/docker/blinkora/backups/release-<时间>-<说明>/`，再在同一文件系统内
暂存并替换。不要删除或重建 `data/app`、`data/postgres`、`compose/` 或
`local/blinkora.env`。

替换后重启并确认：

```bash
sudo systemctl restart blinkora.service
systemctl is-active blinkora.service
curl -fsS http://127.0.0.1:6676/health
```

若发布异常，用同一个发布备份恢复二进制、`public/` 和 schema，再重启服务；数据库和附件
数据不需要回滚。

## 迁移基线

生产数据已迁移到此飞牛目录。源主机保留为备份，不作为日常运行入口。当前 Mac 的本机常驻
服务已停止并禁用；本机 Docker 数据仍保留，但不应拿它覆盖飞牛的生产数据。
