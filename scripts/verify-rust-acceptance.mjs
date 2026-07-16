#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const baseEnv = {
  ...process.env,
  PATH: `/opt/homebrew/opt/rustup/bin:${process.env.HOME}/.cargo/bin:${process.env.PATH}`,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || '/private/tmp/blinkora-server-target',
};

function run(name, command, args, env = {}) {
  console.log(`\n==> ${name}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...baseEnv, ...env },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('rust smoke script syntax', 'node', ['--check', 'scripts/rust-smoke.mjs']);
run('strict S3 smoke script syntax', 'node', ['--check', 'scripts/s3-smoke.mjs']);
run('local S3 smoke script syntax', 'bash', ['-n', 'scripts/s3-smoke-local.sh']);
run('M2 read-only clone smoke script syntax', 'bash', ['-n', 'scripts/m2-readonly-clone-smoke.sh']);
run('M2 final cutover script syntax', 'bash', ['-n', 'scripts/m2-final-cutover.sh']);
run('M2 cutover rollback guardrails', 'bash', ['scripts/verify-m2-cutover-guardrails.sh']);
run('local deployment environment cleanup', 'bash', ['scripts/verify-local-persistent-env-cleanup.sh']);
run('SQLite runtime residuals', 'node', ['scripts/verify-sqlite-runtime-residuals.mjs']);
run('FNAS systemd unit template', 'node', ['scripts/verify-fnas-systemd-unit.mjs']);
run('workspace agent smoke script syntax', 'node', ['--check', 'scripts/workspace-agent-smoke.mjs']);
run('SQLite concurrency script syntax', 'node', ['--check', 'scripts/sqlite-concurrency.mjs']);
run('SQLite bulk script syntax', 'node', ['--check', 'scripts/sqlite-bulk.mjs']);
run('PostgreSQL/SQLite contract script syntax', 'node', ['--check', 'scripts/postgres-sqlite-contract.mjs']);
run('PostgreSQL/SQLite performance script syntax', 'node', ['--check', 'scripts/postgres-sqlite-performance.mjs']);
run('PostgreSQL/SQLite backup performance script syntax', 'node', ['--check', 'scripts/postgres-sqlite-backup-performance.mjs']);
run('SQLite backup shell syntax', 'bash', ['-n', 'scripts/sqlite-backup.sh']);
run('SQLite restore shell syntax', 'bash', ['-n', 'scripts/sqlite-restore.sh']);
run('TypeScript', 'bun', ['run', 'typecheck']);
run('rust unit tests', 'cargo', ['test', '--manifest-path', 'server/Cargo.toml']);
run('PostgreSQL migration tool tests', 'cargo', ['test', '--manifest-path', 'tools/postgres-to-sqlite/Cargo.toml']);

const runtimeTree = spawnSync('cargo', ['tree', '--manifest-path', 'server/Cargo.toml', '-e', 'normal'], {
  encoding: 'utf8',
  env: baseEnv,
});
if (runtimeTree.status !== 0) {
  process.exit(runtimeTree.status ?? 1);
}
if (/sqlx-postgres|tokio-postgres/i.test(`${runtimeTree.stdout}\n${runtimeTree.stderr}`)) {
  console.error('SQLite runtime dependency graph unexpectedly contains a PostgreSQL driver');
  process.exit(1);
}
