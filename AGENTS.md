# AGENTS.md

## Project Overview

Blinkora is a Docker-deployed Web-only private note and memory base. The target product is a clean single-user foundation for long-term notes, wiki-style memory, tags, attachments, references, review, search/RAG, export, and private annotations.

Blinkora is shipped as a browser app served by the Rust backend. Native clients, offline install/runtime shells, public sharing, social features, and conversational AI features are outside the product scope.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, TailwindCSS, HeroUI
- **Primary Backend**: Rust, Axum, SQLx, PostgreSQL
- **Database**: PostgreSQL
- **Package Manager**: Bun (v1.2.8+)
- **Build Tool**: Turbo
- **AI Scope**: Embedding/RAG provider support only

## Project Structure

```text
blinkora/
├── app/             # Web frontend React application
│   └── src/         # React source code
├── server/          # Primary Rust backend
├── db/              # First-release PostgreSQL schema
├── shared/          # Shared utilities and types
├── docker/          # Rust Docker deployment entry
└── docs/            # Architecture notes, tasks, and records
```

## Common Commands

### Setup

```bash
bun install
```

### Development

```bash
bun run dev:rust      # Primary Rust dev backend, default http://127.0.0.1:6677
bun run dev:frontend  # Vite dev server, default http://localhost:5173 and proxies API to Rust dev backend
```

### Build and Verify

```bash
bun run build:web --force  # use before release packaging when validating frontend changes
bun run build:rust-release
bun run verify:rust
```

## Architecture Notes

- **Routing**: React Router v7, Web-only route tree.
- **State Management**: MobX stores in `app/src/store/`.
- **Editor**: Vditor-based Markdown editing.
- **Primary API Runtime**: Rust backend exposes tRPC-compatible endpoints, REST file/auth/backup endpoints, MCP SSE, health checks, and static frontend hosting.
- **Files**: Local filesystem by default; S3-compatible storage is global superadmin configuration and must pass validation before becoming active.
- **Memory Base**: `notes` remains the core fact source; `BLINKORA`, `NOTE`, and `TODO` are the core note types.
- **Annotations**: `comments` are retained as private annotations for user instructions, TODO candidates, wiki update strategy, and filtering hints.
- **Search/RAG**: Keep minimal embedding/vector search infrastructure; improve hybrid search in Rust.

## Development Boundaries

- Keep the product Web-only and Docker-first.
- Keep AI work limited to embedding/RAG configuration and indexing.
- Prefer hard deletion over feature flags for features outside the current product scope.
- Keep export as a data-safety baseline.
- Keep repository docs in `docs/` updated for each substantial change.

## Environment

Root `.env` values for local Bun commands:

```env
DATABASE_URL=postgresql://postgres:mysecretpassword@localhost:55433/postgres
BLINKORA_SECRET=your-secret-key
```

Docker deployment runs from `docker/`; `docker/compose.yml` has local defaults and can optionally read `docker/.env` for production secrets. Storage credentials and embedding provider API keys are configured in the app settings and stored in application config, not required root `.env` keys.

## Deployment

Primary Rust deployment:

```bash
bun run build:rust-release
cd docker
docker compose up -d
```

The default local Rust runtime identity is:

- web container: `blinkora-web`
- database container: `blinkora-db`
- database data path: `docker/data/postgres` on the host, mounted to `/var/lib/postgresql/data`
- local URL: `http://localhost:6676`

## Ports

- Rust Docker Web app and API: `6676`
- Rust local dev API default: `6677`
- Frontend Vite dev server default: `5173`

## Requirements

- Bun >= 1.0.0
- Rust toolchain for `build:rust-release`, or Docker builder fallback
- PostgreSQL
- Docker for local runtime
