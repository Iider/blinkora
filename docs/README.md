# Blinkora docs

This directory keeps public project documentation for the Rust-first Blinkora 1.0 baseline.

## Documents

- [Smoke test checklist](./SMOKE_TEST_CHECKLIST.md): manual verification checklist for the Rust Docker runtime.
- [Bun network strategy](./BUN_NETWORK_STRATEGY.md): registry and build notes for constrained network environments.

## Runtime

- Rust backend: `server/`, `docker/compose.yml`, default local URL `http://localhost:6676`.
- Web frontend: `app/`, built into the Rust release artifact.

Development logs, audit tasks, and session records are local-only material and are not part of the public 1.0 source tree.
