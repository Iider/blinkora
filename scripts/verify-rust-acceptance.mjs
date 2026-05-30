#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const baseEnv = {
  ...process.env,
  PATH: `/opt/homebrew/opt/rustup/bin:${process.env.HOME}/.cargo/bin:${process.env.PATH}`,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || '/private/tmp/blinkora-rust-target',
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
run('rust tRPC parity audit', 'bun', ['run', 'audit:rust-trpc']);
run('rust REST parity audit', 'bun', ['run', 'audit:rust-rest']);
run('rust unit tests', 'cargo', ['test', '--manifest-path', 'server-rust/Cargo.toml']);
