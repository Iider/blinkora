# Blinkora

Blinkora is a Docker-deployed Web-only private note and memory base. This fork keeps the product focused on long-term notes, wiki-style memory, tags, attachments, references, review, search/RAG, export, and private annotations.

Desktop/mobile clients, Tauri, PWA install/offline support, plugin runtime, public sharing, social features, and AI chat orchestration are out of scope. External agents should integrate through the memory/backend APIs rather than live inside Blinkora.

## Backend status

| Backend | Path | Runtime role | Docker entry | Local URL |
| --- | --- | --- | --- | --- |
| Rust | `server-rust/` | Primary backend | `docker/docker-compose.rust.yml` | `http://localhost:6676` |
| TS/Node | `server/` | Reference implementation until Rust no longer needs it | `docker/docker-compose.yml` | `http://localhost:6678` when run manually |
| Go | archived | Removed from the active tree | `docker/backups/` local ignored archive | none |

The Rust backend serves REST APIs, tRPC-compatible endpoints, file APIs, MCP SSE, health checks, SQL migrations, and React/Vite static assets from a single binary. The TS/Node backend remains only as a behavioral reference while Rust parity continues.

## Rust Docker deployment

Build release artifacts on a development machine or CI runner:

```bash
bun run build:rust-release
```

Start the Rust runtime image:

```bash
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml build web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml up -d
```

Smoke test the Rust stack with a local test account:

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```

Use `bun run build:web --force` before release packaging when validating frontend-only changes, so Turbo does not restore stale static assets. The deployment server only needs Docker after `release/rust` has been produced. The Rust runtime image does not include Node, Bun, npm, cargo, Go, or a Rust compiler.

## TS/Node reference stack

Use the TS/Node stack only for behavior comparison while Rust is still being hardened:

```bash
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.yml build web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.yml up -d
```

The TS/Node reference stack maps to `http://localhost:6678` to avoid colliding with the Rust primary stack on `6676`.

## Development commands

```bash
bun install
bun run prisma:generate
bun run dev:rust
bun run dev:frontend
bun run build:web --force
bun run verify:rust
```

Frontend dev uses `http://localhost:5173` and proxies API requests to the Rust dev backend at `http://127.0.0.1:6677` by default. Override with `BLINKORA_DEV_FRONTEND_PORT` or `BLINKORA_DEV_BACKEND_URL` when needed.

## Data and export

- Rust app data: `docker/data/blinkora-rust`
- Rust Postgres data: `docker/data/postgres-rust`
- Rust backup/export directory: `docker/data/backup-rust`
- Go stack archive: local-only ignored backup under `docker/backups/`

Keep export and backup paths working before any schema or storage change.
