# Development Notes

`server/` 是唯一维护的服务端。开发环境直接运行 Rust 后端和 Vite 前端，不使用容器运行时。

## 本地开发

终端一：

```bash
bun run dev:rust
```

终端二：

```bash
bun run dev:frontend
```

| 服务 | 默认地址 | 数据目录 |
| --- | --- | --- |
| Rust 开发后端 | `http://127.0.0.1:6677` | `.blinkora/dev` |
| Vite 前端 | `http://localhost:5173` | 代理到 Rust 开发后端 |

## 发布形态检查

Linux x86_64 静态单二进制：

```bash
bun run build:linux-headless
```

macOS 本机常驻服务：

```bash
bun run deploy:local install
bun run deploy:local status
```

## 最小检查

```bash
bun run typecheck
bun run build:web --force
bun run verify:rust
```

开发数据库完整性：

```bash
sqlite3 .blinkora/dev/blinkora.sqlite3 'PRAGMA integrity_check;'
```

对已启动的隔离或测试服务执行 API smoke：

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```
