#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const postgresBase = process.env.BLINKORA_POSTGRES_BASE_URL || '';
const sqliteBase = process.env.BLINKORA_SQLITE_BASE_URL || '';
const user = process.env.BLINKORA_SMOKE_USER || '';
const password = process.env.BLINKORA_SMOKE_PASSWORD || '';
const samples = Math.max(3, Number(process.env.BLINKORA_BACKUP_PERF_SAMPLES || 5));
const format = process.env.BLINKORA_BACKUP_PERF_FORMAT || 'markdown';
const scope = process.env.BLINKORA_BACKUP_PERF_SCOPE || 'workspace';
const reportPath = process.env.BLINKORA_BACKUP_PERF_REPORT_PATH || '';

if (!postgresBase || !sqliteBase || !user || !password) {
  throw new Error(
    'BLINKORA_POSTGRES_BASE_URL, BLINKORA_SQLITE_BASE_URL, BLINKORA_SMOKE_USER and BLINKORA_SMOKE_PASSWORD are required',
  );
}
if (!['markdown', 'json'].includes(format) || !['workspace', 'full'].includes(scope)) {
  throw new Error('BLINKORA_BACKUP_PERF_FORMAT must be markdown or json; BLINKORA_BACKUP_PERF_SCOPE must be workspace or full');
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function metric(values) {
  return {
    count: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Export downloads are ZIP files and intentionally bypass JSON parsing.
  }
  if (!response.ok || json?.error) {
    throw new Error(`${options.method || 'GET'} ${route} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return { response, text, json };
}

async function login(base) {
  const result = await request(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: user, password }),
  });
  if (!result.json?.token) throw new Error(`login response has no token from ${base}`);
  return result.json.token;
}

async function trpc(base, procedure, input, token) {
  const result = await request(base, `/api/trpc/${procedure}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  return result.json?.result?.data?.json;
}

async function exportBackup(base, token) {
  const startedAt = performance.now();
  const exportResult = await request(base, '/api/trpc/task.exportMarkdown', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ json: { format, scope } }),
  });
  const downloadUrl = exportResult.json?.result?.data?.json?.downloadUrl;
  if (!downloadUrl) throw new Error('export response has no downloadUrl');
  const download = await fetch(`${base}${downloadUrl}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!download.ok) throw new Error(`export download failed (${download.status})`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  return { elapsedMs: performance.now() - startedAt, bytes };
}

async function importBackup(base, token, bytes, fileName) {
  const startedAt = performance.now();
  const form = new FormData();
  form.append('mode', scope);
  form.append('file', new Blob([bytes], { type: 'application/zip' }), fileName);
  const result = await request(base, '/api/backup/import', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (result.json?.success !== true || result.json.workspaceCount < 1) {
    throw new Error('import response did not report a restored workspace');
  }
  return {
    elapsedMs: performance.now() - startedAt,
    workspaceIds: result.json.workspaceIds,
  };
}

async function deleteImportedWorkspaces(base, token, workspaceIds) {
  for (const id of workspaceIds || []) {
    const result = await trpc(base, 'workspaces.delete', { id }, token);
    if (result?.success !== true) throw new Error(`could not remove imported workspace ${id}`);
  }
}

async function main() {
  const [postgresToken, sqliteToken] = await Promise.all([login(postgresBase), login(sqliteBase)]);
  const postgresExport = [];
  const sqliteExport = [];
  const postgresImport = [];
  const sqliteImport = [];
  const archiveBytes = [];

  for (let index = 0; index < samples; index += 1) {
    const runPostgresFirst = index % 2 === 0;
    const run = async (base, token, exported, imported, label) => {
      const archive = await exportBackup(base, token);
      exported.push(archive.elapsedMs);
      archiveBytes.push({ backend: label, bytes: archive.bytes.length });
      const restored = await importBackup(base, token, archive.bytes, `backup-performance-${label}-${index}.zip`);
      imported.push(restored.elapsedMs);
      await deleteImportedWorkspaces(base, token, restored.workspaceIds);
    };
    if (runPostgresFirst) {
      await run(postgresBase, postgresToken, postgresExport, postgresImport, 'postgres');
      await run(sqliteBase, sqliteToken, sqliteExport, sqliteImport, 'sqlite');
    } else {
      await run(sqliteBase, sqliteToken, sqliteExport, sqliteImport, 'sqlite');
      await run(postgresBase, postgresToken, postgresExport, postgresImport, 'postgres');
    }
  }

  const exportPostgres = metric(postgresExport);
  const exportSqlite = metric(sqliteExport);
  const importPostgres = metric(postgresImport);
  const importSqlite = metric(sqliteImport);
  const exportRatio = exportSqlite.p95Ms / exportPostgres.p95Ms;
  const importRatio = importSqlite.p95Ms / importPostgres.p95Ms;
  const report = {
    ok: exportRatio <= 1.5 && importRatio <= 1.5,
    samples,
    format,
    scope,
    archiveBytes,
    export: {
      postgres: exportPostgres,
      sqlite: exportSqlite,
      sqliteToPostgresP95Ratio: Number(exportRatio.toFixed(3)),
      passes150PercentGate: exportRatio <= 1.5,
    },
    import: {
      postgres: importPostgres,
      sqlite: importSqlite,
      sqliteToPostgresP95Ratio: Number(importRatio.toFixed(3)),
      passes150PercentGate: importRatio <= 1.5,
    },
  };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (!report.ok) process.exit(1);
}

main().catch(async (error) => {
  const report = { ok: false, message: error.message };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
});
