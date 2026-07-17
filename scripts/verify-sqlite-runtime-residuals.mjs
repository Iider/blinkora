#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const publicRuntimeFiles = [
  'AGENTS.md',
  'DEV.md',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'docker/README.md',
  'docs/BUN_NETWORK_STRATEGY.md',
  'docs/FNAS_PERSISTENT_DEPLOYMENT.md',
  'docs/LINUX_HEADLESS_DEPLOYMENT.md',
  'docs/LOCAL_PERSISTENT_DEPLOYMENT.md',
  'docs/NOTE_STATE_LIFECYCLE.md',
  'docs/README.md',
  'docs/SMOKE_TEST_CHECKLIST.md',
  'docs/WORKSPACE_AGENT_ACCESS.md',
  'docs/WORKSPACE_DATA_LIFECYCLE.md',
  'server/README.md',
];

const runtimeSourceRoots = [
  'server/src',
  'server/build.rs',
  'db/schema.sqlite.sql',
  'server/Cargo.toml',
  'docker/rust-builder.Dockerfile',
];

const retiredContainerRuntimeFiles = [
  'docker/.env.tmpl',
  'docker/compose.yml',
  'docker/dockerfile.rust',
  'docker/dockerfile.rust.fullbuild',
];

const deploymentResidues = [
  ['PostgreSQL connection URL', /\bpostgres(?:ql)?:\/\//i],
  ['PostgreSQL shell command', /\bpsql\b/i],
  ['PostgreSQL service container', /\bblinkora-db\b/i],
  ['PostgreSQL default port', /(^|[^\d])(?:5432|55433)(?=$|[^\d])/],
  [
    'PostgreSQL runtime environment variable',
    /\b(?:DATABASE_URL|POSTGRES(?:QL)?_(?:URL|HOST|PORT|USER|PASSWORD|DATABASE|DB)|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE)\b/,
  ],
];

const containerRuntimeResidues = [
  ['Docker Compose runtime command', /\bdocker\s+compose\b/i],
  ['retired Blinkora container identity', /\bblinkora-web\b/i],
  ['retired Docker data directory', /\bdocker\/data\/blinkora\b/i],
];

const postgresSqlResidues = [
  ['PostgreSQL backend reference', /\bpostgres(?:ql)?\b/i],
  ['ILIKE operator', /\bILIKE\b/i],
  ['SIMILAR TO operator', /\bSIMILAR\s+TO\b/i],
  ['jsonb type or function', /\bjsonb(?:_[a-z_]+)?\b/i],
  ['PostgreSQL serial type', /\b(?:bigserial|serial)\b/i],
  ['PostgreSQL aggregate or JSON builder', /\b(?:array_agg|date_trunc|json_build_object|jsonb_build_object)\s*\(/i],
  ['PostgreSQL cast syntax', /::\s*(?:jsonb|text|integer|timestamp(?:tz)?)/i],
];

function readProjectFile(path) {
  const absolutePath = resolve(rootDir, path);
  if (!existsSync(absolutePath)) {
    throw new Error(`required SQLite runtime file is missing: ${path}`);
  }
  return readFileSync(absolutePath, 'utf8');
}

function collectSourceFiles(path) {
  const absolutePath = resolve(rootDir, path);
  const metadata = statSync(absolutePath);
  if (!metadata.isDirectory()) {
    return [absolutePath];
  }

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = resolve(absolutePath, entry.name);
    return entry.isDirectory() ? collectSourceFiles(relative(rootDir, childPath)) : [childPath];
  });
}

function assertNoMatches(files, residues) {
  const failures = [];

  for (const file of files) {
    const path = typeof file === 'string' ? file : relative(rootDir, file);
    const content = typeof file === 'string' ? readProjectFile(file) : readFileSync(file, 'utf8');
    for (const [name, pattern] of residues) {
      if (pattern.test(content)) {
        failures.push(`${path}: ${name}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`SQLite runtime residual check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

function assertContainerRuntimeIsRetired() {
  const remaining = retiredContainerRuntimeFiles.filter((path) => existsSync(resolve(rootDir, path)));
  if (remaining.length > 0) {
    throw new Error(`retired container runtime files must stay absent:\n${remaining.map((path) => `- ${path}`).join('\n')}`);
  }
}

const runtimeSourceFiles = runtimeSourceRoots.flatMap(collectSourceFiles);

assertNoMatches(publicRuntimeFiles, deploymentResidues);
assertNoMatches(publicRuntimeFiles, containerRuntimeResidues);
assertNoMatches(runtimeSourceFiles, postgresSqlResidues);
assertContainerRuntimeIsRetired();

console.log(`SQLite runtime residual check passed (${publicRuntimeFiles.length} runtime documents, ${runtimeSourceFiles.length} runtime source files).`);
