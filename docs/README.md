# Blinkora docs

This directory keeps public project documentation for the Rust-first Blinkora 1.0 baseline.

## Documents

- [Smoke test checklist](./SMOKE_TEST_CHECKLIST.md): manual verification checklist for the Rust Docker runtime.
- [Bun network strategy](./BUN_NETWORK_STRATEGY.md): registry and build notes for constrained network environments.

## Runtime boundary

- Rust backend: primary runtime, `server-rust/`, `docker/docker-compose.rust.yml`, default local URL `http://localhost:6676`.
- TS/Node backend: reference implementation only, `server/`, `docker/docker-compose.yml`, default local URL `http://localhost:6678` when run manually.
- Go backend: removed from the active tree; local backup archives under `docker/backups/` are ignored by Git.

Development logs, audit tasks, and session records are local-only material and are not part of the public 1.0 source tree.
