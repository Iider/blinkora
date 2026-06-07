# Blinkora

Blinkora is a Docker-deployed Web-only private note and memory base for long-term notes, wiki-style memory, tags, attachments, references, review, search/RAG, export, and private annotations.

Blinkora is served as a browser app by the Rust backend. Native clients, offline install/runtime shells, public sharing, social features, and conversational AI features are outside the product scope.

## Runtime

| Module | Path | Role |
| --- | --- | --- |
| Web frontend | `app/` | React/Vite frontend |
| Rust backend | `server/` | Only maintained server runtime |
| Database schema | `db/schema.sql` | First-release PostgreSQL schema |
| Shared code | `shared/` | Frontend-friendly shared types and utilities |
| Docker deployment | `docker/` | Default deployment entry |

The Rust backend serves REST APIs, tRPC-compatible endpoints, file APIs, MCP SSE, health checks, first-run database initialization, and React/Vite static assets from one binary.

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

The local URL is [http://localhost:6676](http://localhost:6676). For public or production deployments, copy `docker/.env.tmpl` to `docker/.env` and replace `BLINKORA_SECRET`.

`bun run build:rust-release` syncs a deployment copy to `docker/release/rust`. A deployment server with `docker/` and its generated `release/rust` contents only needs Docker.

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

## Data

- App data: `docker/data/blinkora`
- Postgres data: `docker/data/postgres`
- Backup/export directory: `docker/data/backup`

## Storage Configuration

Blinkora uses the local file system by default and stores attachments under `docker/data/blinkora/files`. S3-compatible object storage can be enabled from the settings page for providers such as Aliyun OSS, Tencent COS, and other S3-compatible services.

S3 settings are global configuration and require a superadmin account. Endpoint, Access Key ID, Secret Key, Bucket, and Region ID are required. Custom Path is optional; for example, `blinkora/`. When Custom Path is empty, files are stored in the bucket root.

The “Save and validate” action uploads, reads, and deletes a temporary validation object. S3 is enabled only after validation succeeds. If validation fails, active storage stays local while the S3 form remains open for correction.

Keep export and backup paths working before schema or storage changes.
