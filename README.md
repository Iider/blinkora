# Blinkora

English | [简体中文](README.zh-CN.md)

Blinkora is a Docker-first, Web-only private note and memory base for long-term notes, wiki-style knowledge, tags, attachments, references, daily review, operation logs, search, export, and private annotations.

The Rust backend serves the browser app, APIs, health checks, first-run SQLite initialization, and embedded frontend assets from one binary. SQLite and attachments are stored together under `DATA_DIR`. Native clients, public sharing, social features, and built-in conversational AI, RAG, embedding, vector, or semantic-search runtimes are outside the current product scope.

## Runtime

| Module | Path | Role |
| --- | --- | --- |
| Web frontend | `app/` | React/Vite frontend |
| Rust backend | `server/` | Only maintained server runtime |
| Database schema | `db/schema.sqlite.sql` | Build-time embedded SQLite schema |
| Shared code | `shared/` | Frontend-friendly shared types and utilities |
| Docker deployment | `docker/` | Default single-container deployment |

## Requirements

- Bun 1.2.8 or later
- Node.js 20 or later for acceptance and smoke scripts
- Docker with Compose for Docker deployment and Docker-backed Linux builds
- Rust toolchain for native backend development and macOS local deployment

## Quick Start

### Docker

Docker is the default deployment path:

```bash
bun install
bun run build:rust-release
cd docker
docker compose up -d
```

Open [http://localhost:6676](http://localhost:6676). Production secrets, rebuilds, storage paths, and smoke tests are documented in [docker/README.md](docker/README.md).

### Headless Linux

Build a static x86_64 Linux binary with the frontend and SQLite schema embedded:

```bash
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:linux-headless
```

The release does not require Docker, Bun, Node.js, Rust, SQLite CLI, a GUI, or FUSE on the target server. Use systemd or another process supervisor and keep configuration and data outside the binary. See [Linux headless deployment](docs/LINUX_HEADLESS_DEPLOYMENT.md) for installation, upgrades, and rollback.

### macOS

Install the Rust service as a persistent `launchd` job without Docker:

```bash
bun run deploy:local install
```

Use `bun run deploy:local status` and `bun run deploy:local logs` for routine checks. See [macOS local persistent deployment](docs/LOCAL_PERSISTENT_DEPLOYMENT.md) for prerequisites, updates, backup, and recovery.

## Development

```bash
bun install
bun run dev:rust
bun run dev:frontend
```

The frontend runs at `http://localhost:5173` and proxies API requests to the Rust backend at `http://127.0.0.1:6677` by default. Override them with `BLINKORA_DEV_FRONTEND_PORT` and `BLINKORA_DEV_BACKEND_URL`.

Common checks:

```bash
bun run typecheck
bun run build:web --force
bun run verify:rust
```

Backend-specific development and initialization details are in [server/README.md](server/README.md).

## Data and Storage

| Deployment | Persistent data |
| --- | --- |
| Docker | `docker/data/blinkora` |
| macOS local service | `~/.blinkora/local/data` |
| Headless Linux | Operator-selected `DATA_DIR` |

Attachments use the local filesystem by default. A superadmin can enable S3-compatible storage from the settings page after an upload/read/delete validation succeeds. Keep SQLite, attachments, and exports backed up together before schema, storage, or deployment changes. Workspace deletion and attachment cleanup rules are documented in [Workspace data lifecycle](docs/WORKSPACE_DATA_LIFECYCLE.md).

## Workspace Agent Access

Workspace tokens created under Settings → Basic Information grant external agents scoped access to one Workspace through MCP and allowlisted APIs. They are not account tokens and cannot access other Workspaces. Protect database backups containing token material, and never store a token in source code, skills, scripts, documentation, or Git history.

See [Workspace agent access](docs/WORKSPACE_AGENT_ACCESS.md) for token permissions, MCP setup, downloadable skills, operation logs, and smoke tests.

## Documentation

Use the [documentation index](docs/README.md) to find deployment runbooks, product behavior contracts, migration records, and test checklists.
