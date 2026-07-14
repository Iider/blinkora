#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

// A long-running SQLite write test. It is intentionally opt-in because the
// default acceptance duration is five minutes and it creates visible test
// notes/comments in the supplied account workspace.
const base = process.env.BLINKORA_BASE_URL || 'http://127.0.0.1:6676';
const user = process.env.BLINKORA_SMOKE_USER || '';
const password = process.env.BLINKORA_SMOKE_PASSWORD || '';
const clients = Math.max(1, Number(process.env.BLINKORA_CONCURRENCY_CLIENTS || 10));
const durationMs = Math.max(1_000, Number(process.env.BLINKORA_CONCURRENCY_DURATION_MS || 300_000));
const reportPath = process.env.BLINKORA_CONCURRENCY_REPORT_PATH || '';
const stamp = Date.now();

if (!user || !password) {
  throw new Error('BLINKORA_SMOKE_USER and BLINKORA_SMOKE_PASSWORD are required');
}

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

function resultData(payload) {
  return payload?.result?.data?.json;
}

async function trpc(path, input, token, method = 'POST') {
  const headers = { Authorization: `Bearer ${token}` };
  let url = `/api/trpc/${path}`;
  const options = { method, headers };
  if (method === 'GET') {
    url += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  } else {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify({ json: input });
  }
  const response = await request(url, options);
  if (!response.response.ok || response.json?.error) {
    const error = new Error(`tRPC ${path} failed with HTTP ${response.response.status}`);
    error.detail = response.json || response.text;
    throw error;
  }
  return resultData(response.json);
}

async function mcpWrite(token, content) {
  const response = await fetch(base + '/sse', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) throw new Error('MCP SSE connection failed');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextEvent = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('MCP SSE closed before a response');
      buffer += decoder.decode(value, { stream: true });
      const delimiter = buffer.indexOf('\n\n');
      if (delimiter < 0) continue;
      const raw = buffer.slice(0, delimiter);
      buffer = buffer.slice(delimiter + 2);
      const event = { event: 'message', data: '' };
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event.event = line.slice(6).trim();
        if (line.startsWith('data:')) event.data += line.slice(5).trimStart();
      }
      return event;
    }
  };
  const endpoint = (await nextEvent()).data.trim();
  const id = Math.floor(Math.random() * 1_000_000);
  const post = await fetch(base + endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'upsertBlinkora', arguments: { content, type: 'blinkora' } },
    }),
  });
  if (post.status !== 202) throw new Error(`MCP write was not accepted: ${post.status}`);
  while (true) {
    const event = await nextEvent();
    if (event.event !== 'message') continue;
    const payload = JSON.parse(event.data);
    if (payload.id !== id) continue;
    await reader.cancel();
    if (payload.result?.isError || !payload.result?.structuredContent?.id) {
      throw new Error('MCP write returned an error');
    }
    return payload.result.structuredContent;
  }
}

async function saveReport(report) {
  if (!reportPath) return;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

const login = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: user, password }),
});
if (!login.response.ok || !login.json?.token) {
  throw new Error('login failed; create the test account first');
}
const token = login.json.token;
const seed = await trpc('notes.upsert', { content: `SQLite concurrency ${stamp} #sqlite-concurrency`, type: 0 }, token);
if (!seed?.id) throw new Error('could not create seed note');
await mcpWrite(token, `SQLite concurrency MCP ${stamp} #sqlite-concurrency`);

const deadline = Date.now() + durationMs;
const failures = [];
let writes = 0;
let reads = 0;

async function worker(index) {
  let iteration = 0;
  while (Date.now() < deadline) {
    try {
      await trpc('notes.list', { page: 1, size: 20, searchText: `SQLite concurrency ${stamp}` }, token, 'GET');
      reads += 1;
      await trpc('notes.upsert', {
        id: seed.id,
        content: `SQLite concurrency ${stamp} worker=${index} iteration=${iteration} #sqlite-concurrency`,
        type: 0,
      }, token);
      await trpc('notes.upsert', {
        content: `SQLite concurrency child ${stamp} worker=${index} iteration=${iteration} #sqlite-concurrency-${index}`,
        type: 0,
      }, token);
      await trpc('comments.create', {
        noteId: seed.id,
        content: `SQLite concurrency comment ${stamp} worker=${index} iteration=${iteration}`,
      }, token);
      writes += 3;
      iteration += 1;
    } catch (error) {
      failures.push({ worker: index, message: error.message, detail: error.detail });
      return;
    }
  }
}

await Promise.all(Array.from({ length: clients }, (_, index) => worker(index)));
const history = await trpc('notes.getNoteHistory', { noteId: seed.id }, token, 'GET');
const versions = (history || []).map((entry) => Number(entry.version)).sort((a, b) => a - b);
const continuous = versions.every((version, index) => version === index + 1);

if (failures.length || !continuous) {
  const report = { ok: false, clients, durationMs, reads, writes, noteId: seed.id, failures, versions };
  await saveReport(report);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
const report = { ok: true, clients, durationMs, reads, writes, noteId: seed.id, historyVersions: versions.length };
await saveReport(report);
console.log(JSON.stringify(report));
