#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const postgresBase = process.env.BLINKORA_POSTGRES_BASE_URL || '';
const sqliteBase = process.env.BLINKORA_SQLITE_BASE_URL || '';
const user = process.env.BLINKORA_SMOKE_USER || '';
const password = process.env.BLINKORA_SMOKE_PASSWORD || '';
const samples = Math.max(20, Number(process.env.BLINKORA_PERF_SAMPLES || 100));
const warmup = Math.max(0, Number(process.env.BLINKORA_PERF_WARMUP || 20));
const reportPath = process.env.BLINKORA_PERF_REPORT_PATH || '';

if (!postgresBase || !sqliteBase || !user || !password) {
  throw new Error(
    'BLINKORA_POSTGRES_BASE_URL, BLINKORA_SQLITE_BASE_URL, BLINKORA_SMOKE_USER and BLINKORA_SMOKE_PASSWORD are required',
  );
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function request(base, route, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${base}${route}`, options);
  const body = await response.text();
  const elapsedMs = performance.now() - startedAt;
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // All benchmarked endpoints are JSON; report only a digest if one is not.
  }
  if (!response.ok || json?.error) {
    const bodyHash = createHash('sha256').update(body).digest('hex');
    throw new Error(
      `${options.method || 'GET'} ${route} failed (${response.status}); response-bytes=${Buffer.byteLength(body)}; sha256=${bodyHash}`,
    );
  }
  return { elapsedMs, json };
}

async function login(base) {
  const { json } = await request(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: user, password }),
  });
  if (!json?.token) throw new Error(`login response has no token from ${base}`);
  return json.token;
}

async function trpc(base, procedure, input, token, method = 'POST') {
  const headers = { Authorization: `Bearer ${token}` };
  let route = `/api/trpc/${procedure}`;
  const options = { method, headers };
  if (method === 'GET') {
    route += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  } else {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify({ json: input });
  }
  const result = await request(base, route, options);
  return { elapsedMs: result.elapsedMs, value: result.json?.result?.data?.json };
}

function metric(values) {
  return {
    count: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

async function runEndpoint(label, postgresCall, sqliteCall) {
  for (let index = 0; index < warmup; index += 1) {
    // Alternating preserves comparable warmed connection pools without always
    // giving one backend the colder position in the pair.
    if (index % 2 === 0) {
      await postgresCall(index, true);
      await sqliteCall(index, true);
    } else {
      await sqliteCall(index, true);
      await postgresCall(index, true);
    }
  }

  const postgres = [];
  const sqlite = [];
  for (let index = 0; index < samples; index += 1) {
    if (index % 2 === 0) {
      postgres.push(await postgresCall(index, false));
      sqlite.push(await sqliteCall(index, false));
    } else {
      sqlite.push(await sqliteCall(index, false));
      postgres.push(await postgresCall(index, false));
    }
  }
  const postgresMetric = metric(postgres);
  const sqliteMetric = metric(sqlite);
  const ratio = sqliteMetric.p95Ms / postgresMetric.p95Ms;
  return {
    label,
    postgres: postgresMetric,
    sqlite: sqliteMetric,
    sqliteToPostgresP95Ratio: Number(ratio.toFixed(3)),
    passes120PercentGate: ratio <= 1.2,
  };
}

async function main() {
  const [postgresToken, sqliteToken] = await Promise.all([login(postgresBase), login(sqliteBase)]);
  const [postgresList, sqliteList] = await Promise.all([
    trpc(postgresBase, 'notes.list', { page: 1, size: 200 }, postgresToken, 'GET'),
    trpc(sqliteBase, 'notes.list', { page: 1, size: 200 }, sqliteToken, 'GET'),
  ]);
  const sqliteNotes = new Map((sqliteList.value || []).map((note) => [note.id, note]));
  const postgresNote = postgresList.value?.find((note) => {
    const sqliteNote = sqliteNotes.get(note.id);
    return (
      Number.isInteger(note.id)
      && typeof note.content === 'string'
      && note.content.trim().length > 0
      && sqliteNote?.content === note.content
      && sqliteNote?.type === note.type
    );
  });
  const sqliteNote = sqliteNotes.get(postgresNote?.id);
  if (!postgresNote?.id || !sqliteNote?.id) {
    throw new Error('fixture must contain the same nonempty visible note in both backends');
  }
  const searchText = String(postgresNote.content || '').trim().slice(0, 24);

  let benchmarks;
  try {
    benchmarks = [
      await runEndpoint(
        'list',
        () => trpc(postgresBase, 'notes.list', { page: 1, size: 50, includePageInfo: true }, postgresToken, 'GET').then((item) => item.elapsedMs),
        () => trpc(sqliteBase, 'notes.list', { page: 1, size: 50, includePageInfo: true }, sqliteToken, 'GET').then((item) => item.elapsedMs),
      ),
      await runEndpoint(
        'detail',
        () => trpc(postgresBase, 'notes.detail', { id: postgresNote.id }, postgresToken, 'GET').then((item) => item.elapsedMs),
        () => trpc(sqliteBase, 'notes.detail', { id: postgresNote.id }, sqliteToken, 'GET').then((item) => item.elapsedMs),
      ),
      await runEndpoint(
        'substring-search',
        () => trpc(postgresBase, 'notes.list', { page: 1, size: 50, searchText }, postgresToken, 'GET').then((item) => item.elapsedMs),
        () => trpc(sqliteBase, 'notes.list', { page: 1, size: 50, searchText }, sqliteToken, 'GET').then((item) => item.elapsedMs),
      ),
      await runEndpoint(
        'write',
        (index) => trpc(
          postgresBase,
          'notes.upsert',
          { id: postgresNote.id, content: `${postgresNote.content}\n<!-- perf-postgres-${index % 2} -->`, type: postgresNote.type },
          postgresToken,
        ).then((item) => item.elapsedMs),
        (index) => trpc(
          sqliteBase,
          'notes.upsert',
          { id: postgresNote.id, content: `${sqliteNote.content}\n<!-- perf-sqlite-${index % 2} -->`, type: sqliteNote.type },
          sqliteToken,
        ).then((item) => item.elapsedMs),
      ),
    ];
  } finally {
    await Promise.all([
      trpc(
        postgresBase,
        'notes.upsert',
        { id: postgresNote.id, content: postgresNote.content, type: postgresNote.type },
        postgresToken,
      ),
      trpc(
        sqliteBase,
        'notes.upsert',
        { id: sqliteNote.id, content: sqliteNote.content, type: sqliteNote.type },
        sqliteToken,
      ),
    ]);
  }
  const report = {
    ok: benchmarks.every((item) => item.passes120PercentGate),
    samples,
    warmup,
    fixture: { noteId: postgresNote.id, searchTextLength: searchText.length },
    benchmarks,
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
