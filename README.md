# Blinkora

English | [简体中文](README.zh-CN.md)

Blinkora is a native-binary-first, Web-only private note and memory base for long-term notes, wiki-style knowledge, tags, attachments, references, daily review, operation logs, search, export, and private annotations.

One Rust executable serves the browser app, APIs, health checks, first-run SQLite initialization, and embedded frontend assets. SQLite and attachments stay under `DATA_DIR`; upgrades never replace configuration or data. Blinkora does not require a container runtime.

Native clients, public sharing, social features, built-in conversational AI, RAG, embeddings, vector search, and semantic search are outside the current product scope.

## Runtime

| Module | Path | Role |
| --- | --- | --- |
| Web frontend | `app/` | React/Vite frontend embedded into the release binary |
| Rust backend | `server/` | Only maintained service runtime |
| Database schema | `db/schema.sqlite.sql` | Build-time embedded SQLite schema |
| Shared code | `shared/` | Frontend-friendly shared types and utilities |
| Release templates | `deploy/linux-package/` | Agent guide, installer, and systemd unit embedded in Linux share packages |
| Release scripts | `scripts/` | Linux packaging, macOS service installation, smoke, and backup |

## Release Scope

| Platform | Delivery |
| --- | --- |
| x86_64 headless Linux | Static single binary; primary release target |
| macOS | Native Rust service installed through `launchd` |
| Windows | Unsupported; development and release work is paused |
| Linux arm64 | Unsupported; no release is currently planned |

Windows is not a current build, test, or delivery target. Restoring support requires a new design for first-run setup, data paths, background execution, upgrades, signing, and clean-system acceptance; a successful compilation alone does not make it supported.

## Run the Linux Binary

Use the prebuilt `blinkora-server-<version>-linux-x86_64` release file. A temporary local-only start needs no installer:

```bash
chmod +x blinkora-server-<version>-linux-x86_64
mkdir -p data
NODE_ENV=production \
BLINKORA_SECRET="$(openssl rand -hex 32)" \
DATA_DIR="$PWD/data" \
./blinkora-server-<version>-linux-x86_64
```

Open `http://127.0.0.1:6676`. For persistent or network access, use the [Linux systemd guide](docs/LINUX_HEADLESS_DEPLOYMENT.md); it stores a stable secret outside the binary and covers upgrades, backup, and rollback.

Maintainers build the release with:

```bash
bun install
bun run build:linux-headless
```

Outputs include the standalone binary and SHA-256 file plus a shareable `blinkora-<version>-linux-x86_64.tar.gz` deployment package. The archive contains an Agent guide, installer, systemd unit, version metadata, and per-file checksums; after extraction, the recipient's Agent should read `AGENTS.md` before running preflight and installation. Docker is optional on the build machine when the native Linux musl cross-compiler is unavailable; the target server never needs it.

## macOS

Build and install the native Rust service as a persistent `launchd` job:

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

The frontend runs at `http://localhost:5173` and proxies API requests to the Rust backend at `http://127.0.0.1:6677`. Development data defaults to `.blinkora/dev`. Override the endpoints with `BLINKORA_DEV_FRONTEND_PORT` and `BLINKORA_DEV_BACKEND_URL`.

Common checks:

```bash
bun run typecheck
bun run build:web --force
bun run verify:rust
```

Backend-specific development and initialization details are in [server/README.md](server/README.md).

## Data and Storage

| Runtime | Persistent data |
| --- | --- |
| Headless Linux | Operator-selected `DATA_DIR` |
| macOS local service | `~/.blinkora/local/data` |
| Local development | `.blinkora/dev` |

Attachments use the local filesystem by default. A superadmin can enable S3-compatible storage after upload/read/delete validation succeeds. Keep SQLite, attachments, and exports backed up together before schema, storage, or deployment changes. Workspace deletion and attachment cleanup rules are documented in [Workspace data lifecycle](docs/WORKSPACE_DATA_LIFECYCLE.md).

## Workspace Agent Access

Workspace tokens created under Settings → Basic Information grant external agents scoped access to one Workspace through MCP and allowlisted APIs. They are not account tokens and cannot access other Workspaces. Protect database backups containing token material, and never store a token in source code, skills, scripts, documentation, or Git history.

See [Workspace agent access](docs/WORKSPACE_AGENT_ACCESS.md) for token permissions, MCP setup, downloadable skills, operation logs, and smoke tests.

## Documentation

Use the [documentation index](docs/README.md) to find deployment runbooks, product behavior contracts, migration records, and test checklists.
