# Docker Development Notes

当前默认运行栈是 Rust 后端，TS/Node 后端只作为行为参考保留。

## Rust 默认运行方式

```bash
bun run build:rust-release
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml build web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml up -d
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml ps
```

访问地址：

```text
http://localhost:6676
```

## Rust 运行身份

- Compose project：`blinkora-rust`
- Web container：`blinkora-rust-web`
- Postgres container：`blinkora-rust-db`
- Web image：`blinkora-rust-web:latest`
- Port mapping：`6676:6676`
- Postgres data：`docker/data/postgres-rust`


## TS/Node 参考栈

TS/Node 参考栈只用于对照 Rust 行为，端口为 `6678`：

```bash
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.yml up -d
```

## 最小烟测

```bash
curl -I http://localhost:6676/
curl -I http://localhost:6676/signin
curl -s http://localhost:6676/health
docker exec blinkora-rust-db psql -U postgres -d postgres -Atc 'select count(*) from "_prisma_migrations";'
```

## 固化烟测

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```
