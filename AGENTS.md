# AGENTS.md

## Project Overview

Blinkora is a native-binary-first, Web-only private note and memory base. The target product is a clean single-user foundation for long-term notes, wiki-style memory, tags, attachments, references, daily review, search, export, and private annotations.

Blinkora is shipped as a browser app served by one Rust binary. The binary embeds the React frontend and SQLite schema; SQLite and attachments stay under `DATA_DIR`. Headless x86_64 Linux uses systemd, and personal macOS machines use `launchd`. Docker is not a runtime or deployment target; it is allowed only as an optional build-machine fallback for Linux cross-compilation. Native clients, public sharing, social features, and conversational AI features are outside the product scope.

Windows is not a supported build, test, or release target. Windows development and packaging are paused; restoring them requires a new explicit design decision and platform acceptance plan.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, TailwindCSS, HeroUI
- **Primary Backend**: Rust, Axum, SQLx, SQLite
- **Database**: SQLite (single service process, local filesystem only)
- **Package Manager**: Bun (v1.2.8+)
- **Build Tool**: Turbo
- **AI Scope**: No built-in RAG, embedding, semantic search, or conversational AI runtime. Workspace Agent/MCP is only an external access path for authorized agents to read and write Blinkora data.

## Project Structure

```text
blinkora/
├── app/             # Web frontend React application
│   └── src/         # React source code
├── server/          # Primary Rust backend
├── db/              # Runtime SQLite schema
├── shared/          # Shared utilities and types
├── scripts/         # Build, native deployment, migration, and smoke scripts
├── deploy/          # Native Linux share-package templates and NAS units
├── docker/          # Optional Linux Rust builder; never a runtime image
└── docs/            # Architecture notes, runbooks, tasks, and records
```

## Common Commands

### Setup

```bash
bun install
```

### Development

```bash
bun run dev:rust      # Rust dev backend on http://127.0.0.1:6677
bun run dev:frontend  # Vite on http://localhost:5173, proxying to the Rust backend
```

### Build and Verify

```bash
bun run typecheck
bun run build:web --force
bun run build:linux-headless
bun run deploy:local install
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
- **Daily Review**: `review`, `reviewed`, and `isReviewed` mean personal daily review status. They do not mean moderation, approval, publishing review, or content audit.
- **Search**: Keep ordinary keyword, metadata, type, tag, attachment, link, TODO, and date filtering clear and predictable. RAG/vector/embedding search is not part of the current runtime.

## Development Boundaries

- Keep the product Web-only and native-binary-first. Do not add a container runtime or container-based user deployment without a new explicit design decision.
- Do not add Windows launchers, installers, services, packaging, or release automation without a new explicit design decision.
- Keep production data, configuration, logs, and secrets outside the binary. Upgrades may replace the executable and maintained service definition, but never configuration or data.
- Do not reintroduce RAG, embedding, semantic search, or conversational AI behavior without a fresh design and explicit implementation plan.
- Do not build approval, moderation, publishing-review, or content-audit semantics on top of `isReviewed`; add a separate model if that product need is explicitly designed.
- Prefer hard deletion over feature flags for features outside the current product scope.
- Keep export as a data-safety baseline.
- Keep repository docs in `docs/` updated for each substantial change.

## Environment

The service reads `NODE_ENV`, `BIND_ADDR`, `PORT`, `DATA_DIR`, `BLINKORA_SECRET`, and `RUST_LOG`. Production deployments store them in a permission-restricted environment file outside the repository. Storage credentials are configured in the app settings and stored in application configuration.

Local macOS deployment stores its generated environment file in `~/.blinkora/local/blinkora.env`. Linux systemd examples use `/etc/blinkora/blinkora.env`.

## Deployment

Primary x86_64 Linux release:

```bash
bun run build:linux-headless
```

The output includes the standalone binary, a shareable `.tar.gz` package, and their SHA-256 files. The package contains an Agent guide and guarded systemd installer. The target server runs the binary directly; configuration and data remain outside the executable. See `docs/LINUX_HEADLESS_DEPLOYMENT.md`.

Personal macOS persistent deployment:

```bash
bun run deploy:local install
```

This installs the Rust Web service through `launchd` as `com.blinkora.local`, stores SQLite and attachments in `~/.blinkora/local/data`, and serves `http://localhost:6676`.

## Ports

- Rust persistent Web app and API: `6676`
- Rust local dev API default: `6677`
- Frontend Vite dev server default: `5173`

## Requirements

- A prebuilt Linux release has no Docker, Bun, Node.js, Rust, SQLite CLI, GUI, or FUSE runtime dependency.
- Source builds require Bun 1.2.8+, Node.js 20+, and a Rust toolchain.
- Docker is optional on build machines when the native Linux musl cross-compiler is unavailable.
