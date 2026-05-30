# AGENTS.md

## Project Overview

Blinkora is a Docker-deployed Web-only private note and memory base. The target product is a clean single-user foundation for long-term notes, wiki-style memory, tags, attachments, references, review, search/RAG, export, and private annotations.

Desktop/mobile clients, Tauri, PWA install/offline support, plugin runtime, public sharing, social features, and AI chat orchestration are out of scope. If a desktop wrapper is needed later, build it as a separate lightweight shell that loads the Web URL.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, TailwindCSS, HeroUI
- **Primary Backend**: Rust, Axum, SQLx, PostgreSQL
- **Reference Backend**: TS/Node, Express, tRPC, Prisma ORM; keep only while useful for Rust parity
- **Removed Backend**: Go stack archived at `docker/backups/` local ignored archive
- **Database**: PostgreSQL
- **Package Manager**: Bun (v1.2.8+)
- **Build Tool**: Turbo
- **AI Scope**: Embedding/RAG provider support only; chat and agent orchestration should live outside Blinkora

## Project Structure

```text
blinkora/
├── app/             # Web frontend React application
│   └── src/         # React source code
├── server-rust/     # Primary Rust backend
├── server/          # TS/Node reference backend
├── prisma/          # Database schema and migrations
├── shared/          # Shared utilities and types
├── docker/          # Rust primary and TS reference Docker entries
└── docs/            # Architecture notes, tasks, and records
```

## Common Commands

### Setup

```bash
bun install
bun run prisma:generate
```

### Development

```bash
bun run dev:rust      # Primary Rust dev backend, default http://127.0.0.1:6677
bun run dev:frontend  # Vite dev server, default http://localhost:5173 and proxies API to Rust dev backend
bun run dev:backend   # TS/Node reference backend only
bun run prisma:studio
```

### Build and Verify

```bash
bun run build:web --force  # use before release packaging when validating frontend changes
bun run build:rust-release
bun run verify:rust
```

### Database

```bash
bun run prisma:migrate:deploy
bun run seed
```

## Architecture Notes

- **Routing**: React Router v7, Web-only route tree.
- **State Management**: MobX stores in `app/src/store/`.
- **Editor**: Vditor-based Markdown editing.
- **Primary API Runtime**: Rust backend exposes tRPC-compatible endpoints, REST file/auth/backup endpoints, MCP SSE, health checks, and static frontend hosting.
- **Reference API Runtime**: TS/Node backend remains available for behavior comparison until Rust no longer needs it.
- **Files**: Local filesystem or S3-compatible storage.
- **Memory Base**: `notes` remains the core fact source; `BLINKORA`, `NOTE`, and `TODO` are the core note types.
- **Annotations**: `comments` are retained as private annotations for user instructions, TODO candidates, wiki update strategy, and filtering hints.
- **Search/RAG**: Keep minimal embedding/vector search infrastructure; improve hybrid search in Rust.

## Development Boundaries

- Do not reintroduce Tauri, desktop global hotkeys, tray, autostart, desktop updater, Android/iOS shortcuts, PWA manifest, or service worker registration.
- Do not add AI chat pages or agent orchestration back into Blinkora; integrate external agents through future memory-backend tools or a separate OpenClaw plugin.
- Do not restore the Go backend into the active tree unless explicitly requested; use the archived zip only for reference or recovery.
- Prefer hard deletion over feature flags for removed edge features.
- Keep export as a data-safety baseline.
- Keep repository docs in `docs/` updated for each substantial change.

## Environment

Root `.env` values for local Bun commands:

```env
DATABASE_URL=postgresql://postgres:mysecretpassword@localhost:55433/postgres
JWT_SECRET=your-secret-key
NEXTAUTH_SECRET=your-secret-key
```

Docker Compose templates also set `NEXTAUTH_URL` and `NEXT_PUBLIC_BASE_URL` for deployment metadata. Storage credentials and embedding provider API keys are configured in the app settings and stored in application config, not required root `.env` keys.

## Deployment

Primary Rust deployment:

```bash
bun run build:rust-release
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml build web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml up -d
```

The default local Rust runtime identity is:

- web container: `blinkora-rust-web`
- database container: `blinkora-rust-db`
- database data path: `docker/data/postgres-rust` on the host, mounted to `/var/lib/postgresql/data`
- local URL: `http://localhost:6676`

TS/Node reference stack:

```bash
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.yml up -d
```

The TS/Node reference stack maps to `http://localhost:6678` and should not be treated as the primary runtime.

## Ports

- Rust Docker Web app and API: `6676`
- Rust local dev API default: `6677`
- Frontend Vite dev server default: `5173`
- TS/Node reference stack: `6678`

## Requirements

- Bun >= 1.0.0
- Node.js >= 20.0.0 for TS/Node reference work
- Rust toolchain for `build:rust-release`, or Docker builder fallback
- PostgreSQL
- Docker for local runtime
