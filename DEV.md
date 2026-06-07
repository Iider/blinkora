# Docker Development Notes

当前默认运行栈是 Rust 后端，`server/` 就是唯一维护的服务端。

## Rust 默认运行方式

```bash
bun run build:rust-release
cd docker
docker compose build web
docker compose up -d
docker compose ps
```

访问地址：

```text
http://localhost:6676
```

## Rust 运行身份

- Compose project：`blinkora`
- Web container：`blinkora-web`
- Postgres container：`blinkora-db`
- Web image：`blinkora-web:latest`
- Port mapping：`6676:6676`
- Postgres data：`docker/data/postgres`


## 最小烟测

```bash
curl -I http://localhost:6676/
curl -I http://localhost:6676/signin
curl -s http://localhost:6676/health
docker exec blinkora-db psql -U postgres -d postgres -Atc "select to_regclass('public.accounts');"
```

## 固化烟测

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```
