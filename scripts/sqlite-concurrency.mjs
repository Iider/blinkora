#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

// A long-running SQLite write test. It is intentionally opt-in because the
// default acceptance duration is five minutes and it creates visible test
// notes/comments in the supplied account workspace.
const base = process.env.BLINKORA_BASE_URL || 'http://127.0.0.1:6676';
const user = process.env.BLINKORA_SMOKE_USER || '';
const password = process.env.BLINKORA_SMOKE_PASSWORD || '';
const sqlitePath = process.env.BLINKORA_SQLITE_PATH || '';
const clients = Math.max(1, Number(process.env.BLINKORA_CONCURRENCY_CLIENTS || 10));
const durationMs = Math.max(1_000, Number(process.env.BLINKORA_CONCURRENCY_DURATION_MS || 300_000));
const reportPath = process.env.BLINKORA_CONCURRENCY_REPORT_PATH || '';
const stamp = Date.now();

if (!user || !password || !sqlitePath) {
  throw new Error('BLINKORA_SMOKE_USER, BLINKORA_SMOKE_PASSWORD and BLINKORA_SQLITE_PATH are required');
}

function sqliteScalar(sql) {
  return execFileSync(
    'sqlite3',
    ['-cmd', '.timeout 5000', sqlitePath, sql],
    { encoding: 'utf8' },
  ).trim();
}

function sqliteNumber(sql) {
  return Number(sqliteScalar(sql));
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
await trpc('config.update', { key: 'operationLogNoteTypes', value: [1] }, token);
const seed = await trpc('notes.upsert', { content: `SQLite concurrency ${stamp} #sqlite-concurrency`, type: 1 }, token);
if (!seed?.id) throw new Error('could not create seed note');

const deadline = Date.now() + durationMs;
const failures = [];
const childNoteIds = new Set();
const commentIds = new Set();
const mcpNoteIds = new Set();
const workersWithIterations = new Set();
let writes = 0;
let reads = 0;
let edits = 0;
let childWrites = 0;
let commentWrites = 0;
let mcpWrites = 0;

async function worker(index) {
  let iteration = 0;
  try {
    const mcpNote = await mcpWrite(
      token,
      `SQLite concurrency MCP ${stamp} worker=${index} #sqlite-concurrency-mcp-${index}`,
    );
    if (!mcpNote?.id || mcpNoteIds.has(mcpNote.id)) {
      throw new Error(`MCP write returned duplicate or missing id ${mcpNote?.id}`);
    }
    mcpNoteIds.add(mcpNote.id);
    mcpWrites += 1;
    writes += 1;
  } catch (error) {
    failures.push({ worker: index, message: error.message, detail: error.detail });
    return;
  }
  while (Date.now() < deadline) {
    try {
      await trpc('notes.list', { page: 1, size: 20, searchText: `SQLite concurrency ${stamp}` }, token, 'GET');
      reads += 1;
      const edited = await trpc('notes.upsert', {
        id: seed.id,
        content: `SQLite concurrency ${stamp} worker=${index} iteration=${iteration} #sqlite-concurrency`,
        type: 1,
      }, token);
      if (edited?.id !== seed.id) throw new Error(`seed edit returned unexpected id ${edited?.id}`);
      edits += 1;
      writes += 1;
      const child = await trpc('notes.upsert', {
        content: `SQLite concurrency child ${stamp} worker=${index} iteration=${iteration} #sqlite-concurrency-${index}`,
        type: 0,
      }, token);
      if (!child?.id || childNoteIds.has(child.id)) {
        throw new Error(`child write returned duplicate or missing id ${child?.id}`);
      }
      childNoteIds.add(child.id);
      childWrites += 1;
      writes += 1;
      const comment = await trpc('comments.create', {
        noteId: seed.id,
        content: `SQLite concurrency comment ${stamp} worker=${index} iteration=${iteration}`,
      }, token);
      if (!comment?.id || commentIds.has(comment.id)) {
        throw new Error(`comment write returned duplicate or missing id ${comment?.id}`);
      }
      commentIds.add(comment.id);
      commentWrites += 1;
      writes += 1;
      workersWithIterations.add(index);
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
const versionSummary = {
  count: versions.length,
  min: versions.at(0) ?? null,
  max: versions.at(-1) ?? null,
  firstGap: versions.findIndex((version, index) => version !== index + 1),
};
const persisted = {
  childNotes: sqliteNumber(`SELECT COUNT(*) FROM notes WHERE content LIKE 'SQLite concurrency child ${stamp} %';`),
  distinctChildContents: sqliteNumber(`SELECT COUNT(DISTINCT content) FROM notes WHERE content LIKE 'SQLite concurrency child ${stamp} %';`),
  comments: sqliteNumber(`SELECT COUNT(*) FROM comments WHERE content LIKE 'SQLite concurrency comment ${stamp} %';`),
  distinctCommentContents: sqliteNumber(`SELECT COUNT(DISTINCT content) FROM comments WHERE content LIKE 'SQLite concurrency comment ${stamp} %';`),
  mcpNotes: sqliteNumber(`SELECT COUNT(*) FROM notes WHERE content LIKE 'SQLite concurrency MCP ${stamp} %';`),
  distinctMcpContents: sqliteNumber(`SELECT COUNT(DISTINCT content) FROM notes WHERE content LIKE 'SQLite concurrency MCP ${stamp} %';`),
  childTagLinks: sqliteNumber(`SELECT COUNT(*) FROM "tagsToNote" t JOIN notes n ON n.id=t."noteId" WHERE n.content LIKE 'SQLite concurrency child ${stamp} %';`),
  distinctChildTags: sqliteNumber(`SELECT COUNT(DISTINCT t."tagId") FROM "tagsToNote" t JOIN notes n ON n.id=t."noteId" WHERE n.content LIKE 'SQLite concurrency child ${stamp} %';`),
  mcpTagLinks: sqliteNumber(`SELECT COUNT(*) FROM "tagsToNote" t JOIN notes n ON n.id=t."noteId" WHERE n.content LIKE 'SQLite concurrency MCP ${stamp} %';`),
  history: sqliteNumber(`SELECT COUNT(*) FROM "noteHistory" WHERE "noteId" = ${Number(seed.id)};`),
  distinctHistoryVersions: sqliteNumber(`SELECT COUNT(DISTINCT version) FROM "noteHistory" WHERE "noteId" = ${Number(seed.id)};`),
  contentOperationLogs: sqliteNumber(`SELECT COUNT(*) FROM "operationLog" WHERE "noteId" = ${Number(seed.id)} AND json_extract(details, '$.content.previousVersion') IS NOT NULL;`),
  distinctLogVersions: sqliteNumber(`SELECT COUNT(DISTINCT json_extract(details, '$.content.previousVersion')) FROM "operationLog" WHERE "noteId" = ${Number(seed.id)} AND json_extract(details, '$.content.previousVersion') IS NOT NULL;`),
  foreignKeyViolations: sqliteNumber('SELECT COUNT(*) FROM pragma_foreign_key_check;'),
  orphans: sqliteNumber(`
    SELECT
      (SELECT COUNT(*) FROM notes n LEFT JOIN workspaces w ON w.id=n."workspaceId" WHERE n."workspaceId" IS NOT NULL AND w.id IS NULL)
      + (SELECT COUNT(*) FROM "noteHistory" h LEFT JOIN notes n ON n.id=h."noteId" WHERE n.id IS NULL)
      + (SELECT COUNT(*) FROM comments c LEFT JOIN notes n ON n.id=c."noteId" WHERE n.id IS NULL)
      + (SELECT COUNT(*) FROM comments c LEFT JOIN comments p ON p.id=c."parentId" WHERE c."parentId" IS NOT NULL AND p.id IS NULL)
      + (SELECT COUNT(*) FROM attachments a LEFT JOIN notes n ON n.id=a."noteId" WHERE a."noteId" IS NOT NULL AND n.id IS NULL)
      + (SELECT COUNT(*) FROM "tagsToNote" t LEFT JOIN notes n ON n.id=t."noteId" WHERE n.id IS NULL)
      + (SELECT COUNT(*) FROM "tagsToNote" t LEFT JOIN tag g ON g.id=t."tagId" WHERE g.id IS NULL)
      + (SELECT COUNT(*) FROM "noteReference" r LEFT JOIN notes n ON n.id=r."fromNoteId" WHERE n.id IS NULL)
      + (SELECT COUNT(*) FROM "noteReference" r LEFT JOIN notes n ON n.id=r."toNoteId" WHERE n.id IS NULL);
  `),
  integrity: sqliteScalar('PRAGMA integrity_check;'),
};
const persistedExactlyOnce = persisted.childNotes === childWrites
  && persisted.distinctChildContents === childWrites
  && persisted.comments === commentWrites
  && persisted.distinctCommentContents === commentWrites
  && persisted.mcpNotes === mcpWrites
  && persisted.distinctMcpContents === mcpWrites;
const tagWritesComplete = persisted.childTagLinks === childWrites
  && persisted.distinctChildTags === workersWithIterations.size
  && persisted.mcpTagLinks === mcpWrites;
const completeAuditTrail = versions.length === edits
  && persisted.history === edits
  && persisted.distinctHistoryVersions === edits
  && persisted.contentOperationLogs === edits
  && persisted.distinctLogVersions === edits;
const databaseHealthy = persisted.integrity === 'ok'
  && persisted.foreignKeyViolations === 0
  && persisted.orphans === 0;

if (
  failures.length
  || !continuous
  || !persistedExactlyOnce
  || !tagWritesComplete
  || !completeAuditTrail
  || !databaseHealthy
) {
  const report = {
    ok: false,
    clients,
    durationMs,
    reads,
    writes,
    edits,
    childWrites,
    commentWrites,
    mcpWrites,
    workersWithIterations: workersWithIterations.size,
    noteId: seed.id,
    failures,
    versionSummary,
    persisted,
  };
  await saveReport(report);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
const report = {
  ok: true,
  clients,
  durationMs,
  reads,
  writes,
  edits,
  childWrites,
  commentWrites,
  mcpWrites,
  workersWithIterations: workersWithIterations.size,
  noteId: seed.id,
  versionSummary,
  persisted,
};
await saveReport(report);
console.log(JSON.stringify(report));
